const config = require('./config')
const debugModule = require('debug')
const mediasoup = require('mediasoup')
const express = require('express')
const https = require('https')
const createError = require('http-errors')
const fs = require('fs')
const os = require('os')

/* translator for trace event types. */

const eventTypes = new Map(
  [
    ['rtp', 'rtp (packet)'],
    ['pli', 'pli (picture loss indicator)'],
    ['keyframe', 'keyframe'],
    ['fir', 'fir (full intraframe request)'],
    ['nack', 'nack'],
    ['probation', 'probation'],
    ['bwe', 'bwe (bandwidth estimation)']
  ]
)

const app = express()
let httpsServer

const log = debugModule('demo-app')
const clientLog = debugModule('demo-app')
const trace = debugModule('demo-app')
const warn = debugModule('demo-app:WARN')
const err = debugModule('demo-app:ERROR')

// one mediasoup worker and router
//
let worker, router, audioLevelObserver

//
// and one "room" ...
//
const roomState = {
  // external
  peers: {},
  activeSpeaker: { producerId: null, volume: null, peerId: null },
  // internal
  transports: {},
  producers: [],
  consumers: []
}
//
// for each peer that connects, we keep a table of peers and what
// tracks are being sent and received. we also need to know the last
// time we saw the peer, so that we can disconnect clients that have
// network issues.
//
// for this simple demo, each client polls the server at 1hz, and we
// just send this roomState.peers data structure as our answer to each
// poll request.
//
// [peerId] : {
//   joinTs: <ms timestamp>
//   lastSeenTs: <ms timestamp>
//   media: {
//     [mediaTag] : {
//       paused: <bool>
//       encodings: []
//     }
//   },
//   stats: {
//     producers: {
//       [producerId]: {
//         ...(selected producer stats)
//       }
//     consumers: {
//       [consumerId]: { ...(selected consumer stats) }
//     }
//   }
//   consumerLayers: {
//     [consumerId]:
//         currentLayer,
//         clientSelectedLayer,
//       }
//     }
//   }
// }
//
// we also send information about the active speaker, as tracked by
// our audioLevelObserver.
//
// internally, we keep lists of transports, producers, and
// consumers. whenever we create a transport, producer, or consumer,
// we save the remote peerId in the object's `appData`. for producers
// and consumers we also keep track of the client-side "media tag", to
// correlate tracks.
//

//
// our http server needs to send 'index.html' and 'client-bundle.js'.
// might as well just send everything in this directory ...
//
app.use(express.static(__dirname))

// logging
if (false) {
  const logger = require('morgan')
  app.use(logger('tiny', {
    skip: function (req, res, next) {
      if (req.path === '/signaling/sync') return true
      return false
    }
  }))
}

//
// main() -- our execution entry point
//

async function main () {
  // start mediasoup
  log('starting mediasoup');
  ({ worker, router, audioLevelObserver } = await startMediasoup())

  // start https server, falling back to http if https fails
  log('starting express')
  try {
    const tls = {
      cert: fs.readFileSync(config.sslCrt),
      key: fs.readFileSync(config.sslKey),
    }
    httpsServer = https.createServer(tls, app)
    httpsServer.on('error', (e) => {
      err('https server error,', e.message)
    })
    await new Promise((resolve) => {
      httpsServer.listen(config.httpPort, config.httpIp, () => {
        log(`server is running and listening on ` +
          `https://${config.httpIp}:${config.httpPort}`)
        resolve()
      })
    })
  } catch (e) {
    if (e.code === 'ENOENT') {
      warn('no certificates found (check config.js)')
      warn('  could not start https server ... trying http')
    } else {
      err('could not start https server', e)
    }
    app.listen(config.httpPort, config.httpIp, () => {
      log(`http server listening on port ${config.httpPort}`)
    })
  }

  // periodically clean up peers that disconnected without sending us
  // a final "leave" request beacon
  setInterval(() => {
    let now = Date.now()
    Object.entries(roomState.peers).forEach(([id, p]) => {
      if ((now - p.lastSeenTs) > config.httpPeerStale) {
        warn(`removing stale peer ${id}`)
        closePeer(id)
      }
    })
  }, 1000)

  // periodically update video stats we're sending to peers
  setInterval(updatePeerStats, 3000)

  let previousWorkerResource
  let previousTimestamp = Date.now()
  // periodically monitor machine usage
  setInterval((worker) => {
    worker.getResourceUsage()
      .then(workerResource => {
        const now = Date.now()
        const machine = { freemem: os.freemem(), totalmem: os.totalmem(), load: os.loadavg()[0] }
        const maxRss = workerResource.ru_maxrss * 1024
        if (previousWorkerResource) {
          const diffs = {}
          for (const[key, val] of Object.entries(previousWorkerResource)) {
            if (!previousWorkerResource.hasOwnProperty(key)) continue
            if (!workerResource.hasOwnProperty(key)) continue
            diffs[key] = workerResource[key] - val
          }
          const maxRss = workerResource.ru_maxrss * 1024
          const diffRss = diffs.ru_maxrss * 1024
          const freeMemFrac = machine.freemem / machine.totalmem
          const freeMem = (freeMemFrac*100).toFixed(1)
          const load = machine.load.toFixed(2)
          const timeFrac = (diffs.ru_stime + diffs.ru_utime) /
            (now - previousTimestamp)
          const usedCpu = (100*timeFrac).toFixed(1)
          const msg = `producers:${roomState.producers.length} consumers:${roomState.consumers.length} loadAvg:${load} freeMem:${freeMem}% usedCpu:${usedCpu}%`
          if (roomState.producers.length + roomState.consumers.length > 0) {
            console.log(msg)
          }
        }
        previousTimestamp = now
        previousWorkerResource = workerResource
      })
  }, 10000, worker)
}

main()

//
// start mediasoup with a single worker and router
//

async function startMediasoup () {
  let worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  })

  worker.on('died', () => {
    err('mediasoup worker died (this should never happen)')
    process.exit(1)
  })

  const mediaCodecs = config.mediasoup.router.mediaCodecs
  const router = await worker.createRouter({ mediaCodecs })

  // audioLevelObserver for signaling active speaker
  //
  const audioLevelObserver = await router.createAudioLevelObserver({
    interval: 800
  })
  audioLevelObserver.on('volumes', (volumes) => {
    const { producer, volume } = volumes[0]
    log(producer.appData.peerId, 'audio-level volumes event', volume)
    roomState.activeSpeaker.producerId = producer.id
    roomState.activeSpeaker.volume = volume
    roomState.activeSpeaker.peerId = producer.appData.peerId
  })
  audioLevelObserver.on('silence', () => {
    log('audio-level silence event')
    roomState.activeSpeaker.producerId = null
    roomState.activeSpeaker.volume = null
    roomState.activeSpeaker.peerId = null
  })

  return { worker, router, audioLevelObserver }
}

//
// -- our minimal signaling is just http polling --
//

// parse every request body for json, no matter the content-type. this
// lets us use sendBeacon or fetch interchangeably to POST to
// signaling endpoints. (sendBeacon can't set the Content-Type header)
//
app.use(express.json({ type: '*/*' }))

/**
 * incoming client logging requests
 */
app.post('/signaling/log', async (req, res, next) => {
  const { peerId, item, message } = req.body
  clientLog(peerId, item || '', message || '', 'from client')
  return res.status(200).json({status: 200, message: 'OK'})
})

app.post('/signaling/get-config', async (req, res) => {
  const iceServers = await getIceServers()
  if (iceServers) config.iceServers = iceServers
  res.json(config)
})

// --> /signaling/sync
//
// client polling endpoint. send back our 'peers' data structure and
// 'activeSpeaker' info
//
app.post('/signaling/sync', async (req, res, next) => {
  let { peerId } = req.body
  try {
    // make sure this peer is connected. if we've disconnected the
    // peer because of a network outage we want the peer to know that
    // happened, when/if it returns
    if (!roomState.peers[peerId]) {
      return res.send({ error: 'not connected' })
    }

    // update our most-recently-seem timestamp -- we're not stale!
    roomState.peers[peerId].lastSeenTs = Date.now()

    return res.send({
      peers: roomState.peers,
      activeSpeaker: roomState.activeSpeaker
    })
  } catch (e) {
    err(e.message)
    return next(createError(400, 'sync error', e))
  }
})

// --> /signaling/join-as-new-peer
//
// adds the peer to the roomState data structure and creates a
// transport that the peer will use for receiving media. returns
// router rtpCapabilities for mediasoup-client device initialization
//
app.post('/signaling/join-as-new-peer', async (req, res, next) => {
  try {
    let { peerId } = req.body,
      now = Date.now()
    log(peerId, 'join-as-new-peer')

    roomState.peers[peerId] = {
      joinTs: now,
      lastSeenTs: now,
      media: {}, consumerLayers: {}, stats: {}
    }

    return res.send({ routerRtpCapabilities: router.rtpCapabilities })
  } catch (e) {
    err('error in /signaling/join-as-new-peer', e)
    return next(createError(400, 'join error', e))
  }
})

// --> /signaling/leave
//
// removes the peer from the roomState data structure and and closes
// all associated mediasoup objects
//
app.post('/signaling/leave', async (req, res, next) => {
  try {
    let { peerId } = req.body
    log(peerId, 'leave')

    await closePeer(peerId)
    res.send({ left: true })
  } catch (e) {
    err('error in /signaling/leave', e)
    return (createError(400, 'closePeer error', e))
  }
})

function closePeer (peerId) {
  log(peerId, 'closing peer')
  for (let [id, transport] of Object.entries(roomState.transports)) {
    if (transport.appData.peerId === peerId) {
      closeTransport(transport)
    }
  }
  delete roomState.peers[peerId]
}

async function closeTransport (transport) {
  try {
    log(transport.appData.peerId, 'closing transport', transport.id)

    // our producer and consumer event handlers will take care of
    // calling closeProducer() and closeConsumer() on all the producers
    // and consumers associated with this transport
    await transport.close()

    // so all we need to do, after we call transport.close(), is update
    // our roomState data structure
    delete roomState.transports[transport.id]
  } catch (e) {
    err(e)
  }
}

async function closeProducer (producer) {
  log(producer.appData.peerId, 'closing producer', producer.id)
  try {
    await producer.close()

    // remove this producer from our roomState.producers list
    roomState.producers = roomState.producers
      .filter((p) => p.id !== producer.id)

    // remove this track's info from our roomState...mediaTag bookkeeping
    if (roomState.peers[producer.appData.peerId]) {
      delete (roomState.peers[producer.appData.peerId]
        .media[producer.appData.mediaTag])
    }
  } catch (e) {
    err(e)
  }
}

async function closeConsumer (consumer) {
  if (!consumer) return
  log(consumer.appData.peerId, 'closing consumer', consumer.id)
  await consumer.close()

  // remove this consumer from our roomState.consumers list
  roomState.consumers = roomState.consumers.filter((c) => c.id !== consumer.id)

  // remove layer info from from our roomState...consumerLayers bookkeeping
  if (roomState.peers[consumer.appData.peerId]) {
    delete roomState.peers[consumer.appData.peerId].consumerLayers[consumer.id]
  }
}

// --> /signaling/create-transport
//
// create a mediasoup transport object and send back info needed
// to create a transport object on the client side
//
app.post('/signaling/create-transport', async (req, res, next) => {
  try {
    let { peerId, direction } = req.body
    log(peerId, 'create-transport', direction)

    let transport = await createWebRtcTransport({ peerId, direction })

    roomState.transports[transport.id] = transport

    const iceServers = await getIceServers()
    let { id, iceParameters, iceCandidates, dtlsParameters } = transport
    const transportOptions = { id, iceParameters, iceCandidates, dtlsParameters, iceServers: [iceServers] }
    //log(peerId, 'transportOptions')
    return res.send({ transportOptions })
  } catch (e) {
    err('error in /signaling/create-transport', e)
    return next(createError(400, 'createWebRtcTransport error', e))
  }
})

async function createWebRtcTransport ({ peerId, direction }) {
  const {
    listenIps,
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport

  const transport = await router.createWebRtcTransport({
    listenIps: listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
    appData: { peerId, clientDirection: direction }
  })

  await transport.enableTraceEvent(config.transportTrace)
  transport.on('trace', event => {
    trace(peerId, 'transport trace', event.direction, eventTypes.get(event.type), event.info)
  })

  return transport
}

// --> /signaling/connect-transport
//
// called from inside a client's `transport.on('connect')` event
// handler.
//
app.post('/signaling/connect-transport', async (req, res, next) => {
  try {
    let { peerId, transportId, dtlsParameters } = req.body,
      transport = roomState.transports[transportId]

    if (!transport) {
      err(`connect-transport: server-side transport ${transportId} not found`)
      return next(createError(400, `server-side transport ${transportId} not found`))
    }

    log(peerId, 'connect-transport')

    await transport.connect({ dtlsParameters })
    res.send({ connected: true })
  } catch (e) {
    err('error in /signaling/connect-transport', e)
    return next(createError(400, 'transport.connect error', e))
  }
})

// --> /signaling/close-transport
//
// called by a client that wants to close a single transport (for
// example, a client that is no longer sending any media).
//
app.post('/signaling/close-transport', async (req, res) => {
  try {
    let { peerId, transportId } = req.body,
      transport = roomState.transports[transportId]

    if (!transport) {
      err(`close-transport: server-side transport ${transportId} not found`)
      return next(createError(400, `server-side transport ${transportId} not found`))
    }

    log(peerId, 'close-transport')

    await closeTransport(transport)
    res.send({ closed: true })
  } catch (e) {
    err('error in /signaling/close-transport', e)
    return next(createError(400, 'closeTransport error', e))
  }
})

// --> /signaling/close-producer
//
// called by a client that is no longer sending a specific track
//
app.post('/signaling/close-producer', async (req, res) => {
  try {
    let { peerId, producerId } = req.body,
      producer = roomState.producers.find((p) => p.id === producerId)

    if (!producer) {
      err(`close-producer: server-side producer ${producerId} not found`)
      return next(createError(400, `close-producer: server-side producer ${producerId} not found`))
    }

    log(peerId, 'close-producer')

    await closeProducer(producer)
    res.send({ closed: true })
  } catch (e) {
    err('close-producer', e)
    return next(createError(400, 'closeProducer error', e))
  }
})

// --> /signaling/send-track
//
// called from inside a client's `transport.on('produce')` event handler.
//
app.post('/signaling/send-track', async (req, res, next) => {
  try {
    const {
        peerId, transportId, kind, rtpParameters,
        paused = false, appData
      } = req.body,
      transport = roomState.transports[transportId]

    if (!transport) {
      err(`send-track: server-side transport ${transportId} not found`)
      return next(createError(400, `send-track: server-side transport ${transportId} not found`))
    }

    log(req.body.peerId, 'send-track', req.body.kind)
    const producer = await transport.produce({
      kind,
      rtpParameters,
      paused,
      appData: { ...appData, peerId, transportId }
    })

    await producer.enableTraceEvent(config.producerConsumerTrace)
    producer.on('trace', event => {
      trace(producer.appData.peerId, 'producer trace', event.direction, producer.appData.mediaTag,
        eventTypes.get(event.type), event.info)
    })

    // if our associated transport closes, close ourself, too
    producer.on('transportclose', () => {
      log(producer.appData.peerId, 'producer\'s transport closed', producer.id)
      closeProducer(producer)
    })

    // monitor audio level of this producer. we call addProducer() here,
    // but we don't ever need to call removeProducer() because the core
    // AudioLevelObserver code automatically removes closed producers
    if (producer.kind === 'audio') {
      audioLevelObserver.addProducer({ producerId: producer.id })
    }

    roomState.producers.push(producer)
    roomState.peers[peerId].media[appData.mediaTag] = {
      paused,
      encodings: rtpParameters.encodings
    }

    return res.send({ id: producer.id })
  } catch (e) {
  }
})

// --> /signaling/recv-track
//
// create a mediasoup consumer object, hook it up to a producer here
// on the server side, and send back info needed to create a consumer
// object on the client side. always start consumers paused. client
// will request media to resume when the connection completes
//
app.post('/signaling/recv-track', async (req, res, next) => {
  try {
    let { peerId, mediaPeerId, mediaTag, rtpCapabilities } = req.body

    let producer = roomState.producers.find(
      (p) => p.appData.mediaTag === mediaTag &&
        p.appData.peerId === mediaPeerId
    )

    if (!producer) {
      let msg = `server-side producer for ${mediaPeerId}:${mediaTag} not found`
      err('recv-track: ' + msg)
      return next(createError(400, msg))
    }

    if (!router.canConsume({
      producerId: producer.id,
      rtpCapabilities
    })) {
      let msg = `client cannot consume ${mediaPeerId}:${mediaTag}`
      err(`recv-track: ${peerId} ${msg}`)
      return next(createError(400, msg))
    }

    let transport = Object.values(roomState.transports).find((t) =>
      t.appData.peerId === peerId && t.appData.clientDirection === 'recv'
    )

    if (!transport) {
      let msg = `server-side recv transport for ${peerId} not found`
      err('recv-track: ' + msg)
      return next(createError(400, msg))
    }

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true, // see note above about always starting paused
      appData: { peerId, mediaPeerId, mediaTag }
    })

    /* fir: full intra request    pli: picture loss indicator */
    await consumer.enableTraceEvent(config.producerConsumerTrace)
    consumer.on('trace', event => {
      trace(peerId, 'consumer trace', event.direction, mediaTag, eventTypes.get(event.type), event.info)
    })

    // need both 'transportclose' and 'producerclose' event handlers,
    // to make sure we close and clean up consumers in all
    // circumstances
    consumer.on('transportclose', () => {
      log(consumer.appData.peerId, `consumer's transport closed`, consumer.id)
      closeConsumer(consumer)
    })
    consumer.on('producerclose', () => {
      log(consumer.appData.peerId, `consumer's producer closed`, consumer.id)
      closeConsumer(consumer)
    })

    // stick this consumer in our list of consumers to keep track of,
    // and create a data structure to track the client-relevant state
    // of this consumer
    roomState.consumers.push(consumer)
    roomState.peers[peerId].consumerLayers[consumer.id] = {
      currentLayer: null,
      clientSelectedLayer: null
    }

    // update above data structure when layer changes.
    consumer.on('layerschange', (layers) => {

      /* check for the no available bitrate condition when layers is null
       * see https://mediasoup.org/documentation/v3/mediasoup/api/#consumer-on-layerschange */
      if (!layers) {
        if (consumer.paused || consumer.producerPaused) {
          warn(`consumer null layerschange ignored ${mediaPeerId}->${peerId}`, mediaTag)
          return
        }
      }
      log(consumer.appData.peerId, `consumer layerschange ${mediaPeerId}->${peerId}`, mediaTag, layers || 'none')
      if (roomState.peers[peerId] &&
        roomState.peers[peerId].consumerLayers[consumer.id]) {
        roomState.peers[peerId].consumerLayers[consumer.id]
          .currentLayer = (layers && layers.spatialLayer) || undefined
      }
    })

    res.send({
      producerId: producer.id,
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused
    })
  } catch (e) {
    err('error in /signaling/recv-track', e)
    return next(createError(400, 'recv-track error', e))
  }
})

// --> /signaling/pause-consumer
//
// called to pause receiving a track for a specific client
//
app.post('/signaling/pause-consumer', async (req, res, next) => {
  try {
    let { peerId, consumerId } = req.body,
      consumer = roomState.consumers.find((c) => c.id === consumerId)

    if (!consumer) {
      err(`pause-consumer: server-side consumer ${consumerId} not found`)
      return next(createError(400, `pause-consumer: server-side consumer ${consumerId} not found`))
    }

    log(consumer.appData.peerId, 'pause-consumer')

    await consumer.pause()

    res.send({ paused: true })
  } catch (e) {
    err('error in /signaling/pause-consumer', e)
    return next(createError(400, 'consumer.pause error', e))
  }
})

// --> /signaling/resume-consumer
//
// called to resume receiving a track for a specific client
//
app.post('/signaling/resume-consumer', async (req, res, next) => {
  try {
    let { peerId, consumerId } = req.body,
      consumer = roomState.consumers.find((c) => c.id === consumerId)

    if (!consumer) {
      err(`pause-consumer: server-side consumer ${consumerId} not found`)
      return next(createError(400, `pause-consumer: server-side consumer ${consumerId} not found`))
    }

    log(consumer.appData.peerId, 'resume-consumer')

    await consumer.resume()

    res.send({ resumed: true })
  } catch (e) {
    err('error in /signaling/resume-consumer', e)
    return next(createError(400, 'consumer.resume error', e))
  }
})

// --> /signalign/close-consumer
//
// called to stop receiving a track for a specific client. close and
// clean up consumer object
//
app.post('/signaling/close-consumer', async (req, res, next) => {
  try {
    let { peerId, consumerId } = req.body,
      consumer = roomState.consumers.find((c) => c.id === consumerId)

    if (!consumer) {
      err(`close-consumer: server-side consumer ${consumerId} not found`)
      return next(createError(400, `close-consumer: server-side consumer ${consumerId} not found`))
    }

    await closeConsumer(consumer)

    return res.send({ closed: true })
  } catch (e) {
    err('error in /signaling/close-consumer', e)
    return next(createError(400, 'closeConsumer error', e))
  }
})

// --> /signaling/consumer-set-layers
//
// called to set the largest spatial layer that a specific client
// wants to receive
//
app.post('/signaling/consumer-set-layers', async (req, res, next) => {
  try {
    let { peerId, consumerId, spatialLayer } = req.body,
      consumer = roomState.consumers.find((c) => c.id === consumerId)

    if (!consumer) {
      err(`consumer-set-layers: server-side consumer ${consumerId} not found`)
      return next(createError(400, `consumer-set-layers: server-side consumer ${consumerId} not found`))
    }

    log(consumer.appData.peerId, 'consumer-set-layers', spatialLayer)

    await consumer.setPreferredLayers({ spatialLayer })

    res.send({ layersSet: true })
  } catch (e) {
    err('error in /signaling/consumer-set-layers', e)
    return next(createError(400, 'consumer.setPreferredLayers', e))
  }
})

// --> /signaling/pause-producer
//
// called to stop sending a track from a specific client
//
app.post('/signaling/pause-producer', async (req, res, next) => {
  try {
    let { peerId, producerId } = req.body,
      producer = roomState.producers.find((p) => p.id === producerId)

    if (!producer) {
      err(`pause-producer: server-side producer ${producerId} not found`)
      return next(createError(400, `pause-producer: server-side producer ${producerId} not found`))
    }

    log(producer.appData.peerId, 'pause-producer')

    await producer.pause()

    roomState.peers[peerId].media[producer.appData.mediaTag].paused = true

    res.send({ paused: true })
  } catch (e) {
    err('error in /signaling/pause-producer', e)
    return next(createError(400, 'producer.pause error', e))
  }
})

// --> /signaling/resume-producer
//
// called to resume sending a track from a specific client
//
app.post('/signaling/resume-producer', async (req, res, next) => {
  try {
    let { peerId, producerId } = req.body,
      producer = roomState.producers.find((p) => p.id === producerId)

    if (!producer) {
      err(`resume-producer: server-side producer ${producerId} not found`)
      return next(createError(400, `resume-producer: server-side producer ${producerId} not found`))
    }

    log(producer.appData.peerId, 'resume-producer')

    await producer.resume()

    roomState.peers[peerId].media[producer.appData.mediaTag].paused = false

    res.send({ resumed: true })
  } catch (e) {
    err('error in /signaling/resume-producer', e)
    return next(createError(400, 'producer.resume error', e))
  }
})

// Error handler
app.use(function (err, req, res, next) {

  if (req.accepts('json')) {
    res
      .status(err.status)
      .json({
        status: err.status,
        name: err.name,
        message: err.message
      })
  } else {
    res
      .status(err.status)
      .send(`${err.status}: ${err.message}\r\n`)
  }
})

//
// stats
//

async function updatePeerStats () {
  for (let producer of roomState.producers) {
    if (producer.kind !== 'video') {
      continue
    }
    try {
      let stats = await producer.getStats(),
        peerId = producer.appData.peerId
      roomState.peers[peerId].stats[producer.id] = stats.map((s) => ({
        bitrate: s.bitrate,
        fractionLost: s.fractionLost,
        jitter: s.jitter,
        score: s.score,
        rid: s.rid
      }))
    } catch (e) {
      warn('error while updating producer stats', e)
    }
  }

  for (let consumer of roomState.consumers) {
    try {
      let stats = (await consumer.getStats())
          .find((s) => s.type === 'outbound-rtp'),
        peerId = consumer.appData.peerId
      if (!stats || !roomState.peers[peerId]) {
        continue
      }
      roomState.peers[peerId].stats[consumer.id] = {
        bitrate: stats.bitrate,
        fractionLost: stats.fractionLost,
        score: stats.score
      }
    } catch (e) {
      warn('error while updating consumer stats', e)
    }
  }
}

const iceServersCache = {}

async function getIceServers () {
  const now = Date.now()
  if (iceServersCache.expires <= now) return iceServersCache.value
  const axios = require('axios')
  const stunturnCredential = process.env.STUNTURN_SERVICE_CREDENTIAL
  const stunturnUrl = process.env.STUNTURN_SERVICE_URL
  const stunturnTtl = Number(process.env.STUNTURN_SERVICE_TTL || 300_000)
  if (!stunturnCredential || !stunturnUrl) return
  if (typeof stunturnCredential !== 'string') return
  if (typeof stunturnUrl !== 'string') return
  const options = {
    method: 'put',
    data: { format: 'urls' },
    headers: {
      'Authorization': `Basic ${Buffer.from(stunturnCredential).toString('base64')}`
    }
  }
  const response = await axios(stunturnUrl, options)
  if (response.status === 200 && response.data.s === 'ok') {
    const iceServers = response.data.v.iceServers
    iceServersCache.value = iceServers
    iceServersCache.expires = Date.now() + stunturnTtl
    return iceServers
  }
  return null

}

