import * as mediasoup from 'mediasoup-client'
import deepEqual from 'deep-equal'
import debugModule from 'debug'

const $ = document.querySelector.bind(document)
const $$ = document.querySelectorAll.bind(document)
debugModule('mediasoup-client:*')
const log = debugModule('demo-app')
const warn = debugModule('demo-app:WARN')
const err = debugModule('demo-app:ERROR')

//
// export all the references we use internally to manage call state,
// to make it easy to tinker from the js console. for example:
//
//   `Client.camVideoProducer.paused`
//
export const myPeerId = uuidv4()
export let device,
  joined,
  localCam,
  localScreen,
  recvTransport,
  sendTransport,
  camVideoProducer,
  camAudioProducer,
  screenVideoProducer,
  screenAudioProducer,
  currentActiveSpeaker = {},
  lastPollSyncData = {},
  consumers = [],
  pollingInterval

//
// entry point -- called by document.body.onload
//

export async function main () {
  await sig('log', {peerId:myPeerId, item: 'starting'})
  log(myPeerId,  'starting up', 'new')
  try {
    device = new mediasoup.Device()
    await sig('log', {peerId:myPeerId, item: 'device created'})
  } catch (e) {
    if (e.name === 'UnsupportedError') {
      err('demo-app', 'browser not supported for video calls')
      return
    } else {
      err('demo-app', e)
    }
  }

  // use sendBeacon to tell the server we're disconnecting when
  // the page unloads
  window.addEventListener('unload', () => sig('leave', {}, true).then())
}

//
// meeting control actions
//

export async function joinRoom () {
  if (joined) {
    return
  }

  log('demo-app', 'join room')
  $('#join-control').style.display = 'none'

  try {
    // signal that we're a new peer and initialize our
    // mediasoup-client device, if this is our first time connecting
    let { routerRtpCapabilities } = await sig('join-as-new-peer')
    if (!device.loaded) {
      await device.load({ routerRtpCapabilities })
      await sig('log', {peerId:myPeerId, item: 'device loaded'})

    }
    joined = true
    $('#leave-room').style.display = 'initial'
  } catch (e) {
    console.error(e)
    return
  }

  // super-simple signaling: let's poll at 1-second intervals
  pollingInterval = setInterval(async () => {
    let { error } = await pollAndUpdate()
    if (error) {
      clearInterval(pollingInterval)
      err('demo-app', 'poll', error)
    }
  }, 1000)
}

export async function sendCameraStreams () {
  log('demo-app', 'send camera streams')
  $('#send-camera').style.display = 'none'

  // make sure we've joined the room and started our camera. these
  // functions don't do anything if they've already been called this
  // session
  await joinRoom()
  await startCamera()

  // create a transport for outgoing media, if we don't already have one
  if (!sendTransport) {
    sendTransport = await createTransport('send')
    await sig('log', {peerId:myPeerId, item: 'transport created'})

  }

  // start sending video. the transport logic will initiate a
  // signaling conversation with the server to set up an outbound rtp
  // stream for the camera video track. our createTransport() function
  // includes logic to tell the server to start the stream in a paused
  // state, if the checkbox in our UI is unchecked. so as soon as we
  // have a client-side camVideoProducer object, we need to set it to
  // paused as appropriate, too.
  let track = localCam.getVideoTracks()[0]
  if (track) {
    camVideoProducer = await sendTransport.produce({
      track,
      encodings: camEncodings().encodings,
      appData: { mediaTag: 'cam-video' }
    })
    await sig('log', {peerId:myPeerId, item: 'video producer created'})

    if (getCamPausedState()) {
      try {
        await camVideoProducer.pause()
      } catch (e) {
        console.error(e)
      }
    }
  }

  // same thing for audio, but we can use our already-created
  track = localCam.getAudioTracks()[0]
  if (track) {
    camAudioProducer = await sendTransport.produce({
      track,
      appData: { mediaTag: 'cam-audio' }
    })
    await sig('log', {peerId:myPeerId, item: 'audio producer created'})
    if (getMicPausedState()) {
      try {
        camAudioProducer.pause()
      } catch (e) {
        console.error(e)
      }
    }
  }

  $('#stop-streams').style.display = 'initial'
  showCameraInfo()
}

export async function startScreenshare () {
  log('demo-app', 'start screen share')
  $('#share-screen').style.display = 'none'

  // make sure we've joined the room and that we have a sending
  // transport
  await joinRoom()
  if (!sendTransport) {
    sendTransport = await createTransport('send')
  }

  // get a screen share track
  localScreen = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true
  })

  // create a producer for video
  screenVideoProducer = await sendTransport.produce({
    track: localScreen.getVideoTracks()[0],
    encodings: screenshareEncodings(),
    appData: { mediaTag: 'screen-video' }
  })

  // create a producer for audio, if we have it
  if (localScreen.getAudioTracks().length) {
    screenAudioProducer = await sendTransport.produce({
      track: localScreen.getAudioTracks()[0],
      appData: { mediaTag: 'screen-audio' }
    })
  }

  // handler for screen share stopped event (triggered by the
  // browser's built-in screen sharing ui)
  screenVideoProducer.track.onended = async () => {
    log('demo-app', 'screen share stopped')
    try {
      await screenVideoProducer.pause()
      let { error } = await sig('close-producer',
        { producerId: screenVideoProducer.id })
      await screenVideoProducer.close()
      screenVideoProducer = null
      if (error) {
        err('demo-app', error)
      }
      if (screenAudioProducer) {
        let { error } = await sig('close-producer',
          { producerId: screenAudioProducer.id })
        await screenAudioProducer.close()
        screenAudioProducer = null
        if (error) {
          err('demo-app', error)
        }
      }
    } catch (e) {
      console.error(e)
    }
    $('#local-screen-pause-ctrl').style.display = 'none'
    $('#local-screen-audio-pause-ctrl').style.display = 'none'
    $('#share-screen').style.display = 'initial'
  }

  $('#local-screen-pause-ctrl').style.display = 'block'
  if (screenAudioProducer) {
    $('#local-screen-audio-pause-ctrl').style.display = 'block'
  }
}

export async function startCamera () {
  if (localCam) {
    return
  }
  const localCamConstraints = camEncodings().userMediaConstraints
  try {
    localCam = await navigator.mediaDevices.getUserMedia(localCamConstraints)
    const settings = localCam.getVideoTracks()[0].getSettings()
    log('demo-app', 'start camera', `${settings.width}x${settings.height} ${settings.frameRate}fps`)
    await sig('log', {peerId:myPeerId, item: 'stream started', message: `${settings.width}x${settings.height} ${settings.frameRate}fps`})

  } catch (e) {
    err('demo-app', 'start camera', localCamConstraints, e)
  }
}

// switch to sending video from the "next" camera in our
// list (if we have multiple cameras)
export async function cycleCamera () {
  if (!(camVideoProducer && camVideoProducer.track)) {
    warn('demo-app', 'cannot cycle camera - no current camera track')
    return
  }

  log('demo-app', 'cycle camera')

  // find "next" camera in camera list
  let deviceId = await getCurrentDeviceId()
  const allMedia = await navigator.mediaDevices.enumerateDevices()
  const vidMedia = allMedia.filter((d) => d.kind === 'videoinput')
  if (!vidMedia.length > 1) {
    warn('demo-app', 'cannot cycle camera - only one camera')
    return
  }
  let idx = vidMedia.findIndex((d) => d.deviceId === deviceId)
  if (idx === (vidMedia.length - 1)) {
    idx = 0
  } else {
    idx += 1
  }

  // get a new video stream. might as well get a new audio stream too,
  // just in case browsers want to group audio/video streams together
  // from the same media device when possible (though they don't seem to,
  // currently)
  log('demo-app', 'cycle camera', 'getting a video stream from new media device', vidMedia[idx].label)
  const localCamConstraints = camEncodings().userMediaConstraints
  /* put the chosen deviceId item into localCamConstraints.video */
  if (!localCamConstraints.video) localCamConstraints.video = {}
  if (typeof localCamConstraints.video === 'boolean') localCamConstraints.video = {}
  localCamConstraints.video.deviceId = { exact: vidMedia[idx].deviceId }
  try {
    const newCam = await navigator.mediaDevices.getUserMedia(localCamConstraints)
    const newVideoTrack = newCam.getVideoTracks()[0]
    const settings = newVideoTrack.getSettings()
    log('demo-app', 'cycle camera', `${settings.width}x${settings.height} ${settings.frameRate}fps`)
    await sig('log', {peerId:myPeerId, item: 'stream restarted', message: `${settings.width}x${settings.height} ${settings.frameRate}fps`})
    // replace the tracks we are sending
    await camVideoProducer.replaceTrack({ track: newVideoTrack })
    await camAudioProducer.replaceTrack({ track: localCam.getAudioTracks()[0] })
    localCam = newCam
  } catch (e) {
    err('demo-app', 'start camera', localCamConstraints, e)
  }
  // update the user interface
  await showCameraInfo()
}

export async function stopStreams () {
  await sig('log', {peerId:myPeerId, item: 'stop sending streams'})
  if (!(localCam || localScreen)) {
    return
  }
  if (!sendTransport) {
    return
  }

  log('demo-app', 'stop sending media streams')
  $('#stop-streams').style.display = 'none'

  let { error } = await sig('close-transport',
    { transportId: sendTransport.id })
  if (error) {
    err('demo-app', 'stop sending media streams', error)
  }
  // closing the sendTransport closes all associated producers. when
  // the camVideoProducer and camAudioProducer are closed,
  // mediasoup-client stops the local cam tracks, so we don't need to
  // do anything except set all our local variables to null.
  try {
    await sendTransport.close()
  } catch (e) {
    console.error(e)
  }
  sendTransport = null
  camVideoProducer = null
  camAudioProducer = null
  screenVideoProducer = null
  screenAudioProducer = null
  localCam = null
  localScreen = null

  // update relevant ui elements
  $('#send-camera').style.display = 'initial'
  $('#share-screen').style.display = 'initial'
  $('#local-screen-pause-ctrl').style.display = 'none'
  $('#local-screen-audio-pause-ctrl').style.display = 'none'
  await showCameraInfo()
}

export async function leaveRoom () {
  if (!joined) {
    return
  }

  log('demo-app', 'leave room')
  $('#leave-room').style.display = 'none'

  // stop polling
  clearInterval(pollingInterval)

  // close everything on the server-side (transports, producers, consumers)
  let { error } = await sig('leave')
  if (error) {
    err('demo-app', 'leave room', error)
  }

  // closing the transports closes all producers and consumers. we
  // don't need to do anything beyond closing the transports, except
  // to set all our local variables to their initial states
  try {
    recvTransport && await recvTransport.close()
    sendTransport && await sendTransport.close()
  } catch (e) {
    console.error(e)
  }
  recvTransport = null
  sendTransport = null
  camVideoProducer = null
  camAudioProducer = null
  screenVideoProducer = null
  screenAudioProducer = null
  localCam = null
  localScreen = null
  lastPollSyncData = {}
  consumers = []
  joined = false

  // hacktastically restore ui to initial state
  $('#join-control').style.display = 'initial'
  $('#send-camera').style.display = 'initial'
  $('#stop-streams').style.display = 'none'
  $('#remote-video').innerHTML = ''
  $('#share-screen').style.display = 'initial'
  $('#local-screen-pause-ctrl').style.display = 'none'
  $('#local-screen-audio-pause-ctrl').style.display = 'none'
  await showCameraInfo()
  updateCamVideoProducerStatsDisplay()
  updateScreenVideoProducerStatsDisplay()
  await updatePeersDisplay()
}

export async function subscribeToTrack (peerId, mediaTag) {
  log('demo-app', 'subscribe to track', peerId, mediaTag)

  // create a receive transport if we don't already have one
  if (!recvTransport) {
    recvTransport = await createTransport('recv')
  }

  // if we do already have a consumer, we shouldn't have called this method
  let consumer = findConsumerForTrack(peerId, mediaTag)
  if (consumer) {
    err('demo-app', 'subscribe to track', 'already have consumer for track', peerId, mediaTag)
    return
  }

  // ask the server to create a server-side consumer object and send
  // us back the info we need to create a client-side consumer
  let consumerParameters = await sig('recv-track', {
    mediaTag,
    mediaPeerId: peerId,
    rtpCapabilities: device.rtpCapabilities
  })
  log('demo-app', 'subscribe to track', 'consumer parameters', consumerParameters)
  consumer = await recvTransport.consume({
    ...consumerParameters,
    appData: { peerId, mediaTag }
  })
  log('demo-app', 'subscribe to track', 'created new consumer', consumer.id)

  // the server-side consumer will be started in paused state. wait
  // until we're connected, then send a resume request to the server
  // to get our first keyframe and start displaying video
  while (recvTransport.connectionState !== 'connected') {
    log('demo-app', 'subscribe to track', '  transport connstate', recvTransport.connectionState)
    await sleep(100)
  }
  // okay, we're ready. let's ask the peer to send us media
  await resumeConsumer(consumer)

  // keep track of all our consumers
  consumers.push(consumer)

  // ui
  await addVideoAudio(consumer)
  updatePeersDisplay()
}

export async function unsubscribeFromTrack (peerId, mediaTag) {
  let consumer = findConsumerForTrack(peerId, mediaTag)
  if (!consumer) {
    return
  }

  log('demo-app', 'unsubscribe from track', peerId, mediaTag)
  try {
    await closeConsumer(consumer)
  } catch (e) {
    err('demo-app', 'unsubscribe from track', e)
  }
  // force update of ui
  updatePeersDisplay()
}

export async function pauseConsumer (consumer) {
  if (consumer) {
    log('demo-app', 'pause consumer', consumer.appData.peerId, consumer.appData.mediaTag)
    try {
      await sig('pause-consumer', { consumerId: consumer.id })
      await consumer.pause()
    } catch (e) {
      err('demo-app', 'pause consumer', e)
    }
  }
}

export async function resumeConsumer (consumer) {
  if (consumer) {
    log('demo-app', 'resume consumer', consumer.appData.peerId, consumer.appData.mediaTag)
    try {
      await sig('resume-consumer', { consumerId: consumer.id })
      await consumer.resume()
    } catch (e) {
      err('demo-app', 'resume consumer', e)
    }
  }
}

export async function pauseProducer (producer) {
  if (producer) {
    log('demo-app', 'pause producer', producer.appData.mediaTag)
    try {
      await sig('pause-producer', { producerId: producer.id })
      await producer.pause()
    } catch (e) {
      err('demo-app', 'pause producer', e)
    }
  }
}

export async function resumeProducer (producer) {
  if (producer) {
    log('demo-app', 'resume producer', producer.appData.mediaTag)
    try {
      await sig('resume-producer', { producerId: producer.id })
      await producer.resume()
    } catch (e) {
      err('demo-app', 'resume producer', e)
    }
  }
}

async function closeConsumer (consumer) {
  if (!consumer) {
    return
  }
  log('demo-app', 'closing consumer', consumer.appData.peerId, consumer.appData.mediaTag)
  try {
    // tell the server we're closing this consumer. (the server-side
    // consumer may have been closed already, but that's okay.)
    await sig('close-consumer', { consumerId: consumer.id })
    await consumer.close()

    consumers = consumers.filter((c) => c !== consumer)
    removeVideoAudio(consumer)
  } catch (e) {
    err('demo-app', 'closing consumer', e)
  }
}

// utility function to create a transport and hook up signaling logic
// appropriate to the transport's direction
//
async function createTransport (direction) {
  log('demo-app', `create ${direction} transport`)

  // ask the server to create a server-side transport object and send
  // us back the info we need to create a client-side transport
  let transport,
    { transportOptions } = await sig('create-transport', { direction })
  log('demo-app', `create ${direction} transport`, 'transport options', transportOptions)

  if (direction === 'recv') {
    transport = await device.createRecvTransport(transportOptions)
  } else if (direction === 'send') {
    transport = await device.createSendTransport(transportOptions)
  } else {
    throw new Error(`bad transport 'direction': ${direction}`)
  }

  // mediasoup-client will emit a connect event when media needs to
  // start flowing for the first time. send dtlsParameters to the
  // server, then call callback() on success or errback() on failure.
  transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    log('demo-app', 'transport connect event', direction)
    let { error } = await sig('connect-transport', {
      transportId: transportOptions.id,
      dtlsParameters
    })
    if (error) {
      err('demo-app', 'transport connect event', 'error connecting transport', direction, error)
      errback()
      return
    }
    callback()
  })

  if (direction === 'send') {
    // sending transports will emit a produce event when a new track
    // needs to be set up to start sending. the producer's appData is
    // passed as a parameter
    transport.on('produce', async ({ kind, rtpParameters, appData },
      callback, errback) => {
      log('demo-app', 'transport produce event', appData.mediaTag)
      // we may want to start out paused (if the checkboxes in the ui
      // aren't checked, for each media type. not very clean code, here
      // but, you know, this isn't a real application.)
      let paused = false
      if (appData.mediaTag === 'cam-video') {
        paused = getCamPausedState()
      } else if (appData.mediaTag === 'cam-audio') {
        paused = getMicPausedState()
      }
      // tell the server what it needs to know from us in order to set
      // up a server-side producer object, and get back a
      // producer.id. call callback() on success or errback() on
      // failure.
      let { error, id } = await sig('send-track', {
        transportId: transportOptions.id,
        kind,
        rtpParameters,
        paused,
        appData
      })
      if (error) {
        err('demo-app', 'transport produce event', 'error setting up server-side producer', error)
        errback()
        return
      }
      callback({ id })
    })
  }

  // for this simple demo, any time a transport transitions to closed,
  // failed, or disconnected, leave the room and reset
  //
  transport.on('connectionstatechange', async (state) => {
    log('demo-app', `transport ${transport.id} connectionstatechange ${state}`)
    // for this simple sample code, assume that transports being
    // closed is an error (we never close these transports except when
    // we leave the room)
    if (state === 'closed' || state === 'failed' || state === 'disconnected') {
      log('demo-app', `transport ${transport.id} connectionstatechange ${state}`,
        'transport closed ... leaving the room and resetting')
      leaveRoom()
    }
  })

  return transport
}

//
// polling/update logic
//

async function pollAndUpdate () {
  let { peers, activeSpeaker, error } = await sig('sync')
  if (error) {
    return ({ error })
  }

  // always update bandwidth stats and active speaker display
  currentActiveSpeaker = activeSpeaker
  updateActiveSpeaker()
  updateCamVideoProducerStatsDisplay()
  updateScreenVideoProducerStatsDisplay()
  updateConsumersStatsDisplay()

  // decide if we need to update tracks list and video/audio
  // elements. build list of peers, sorted by join time, removing last
  // seen time and stats, so we can easily do a deep-equals
  // comparison. compare this list with the cached list from last
  // poll.
  let thisPeersList = sortPeers(peers),
    lastPeersList = sortPeers(lastPollSyncData)
  if (!deepEqual(thisPeersList, lastPeersList)) {
    await updatePeersDisplay(peers, thisPeersList)
  }

  // if a peer has gone away, we need to close all consumers we have
  // for that peer and remove video and audio elements
  for (let id in lastPollSyncData) {
    if (!peers[id]) {
      log('demo-app', `peer ${id}`, 'has exited')
      consumers.forEach((consumer) => {
        if (consumer.appData.peerId === id) {
          closeConsumer(consumer)
        }
      })
    }
  }

  // if a peer has stopped sending media that we are consuming, we
  // need to close the consumer and remove video and audio elements
  consumers.forEach((consumer) => {
    let { peerId, mediaTag } = consumer.appData
    if (!peers[peerId].media[mediaTag]) {
      log('demo-app', `peer ${peerId}`, 'has stopped transmitting ${mediaTag}')
      closeConsumer(consumer)
    }
  })

  lastPollSyncData = peers
  return ({}) // return an empty object if there isn't an error
}

function sortPeers (peers) {
  return Object.entries(peers)
    .map(([id, info]) => ({ id, joinTs: info.joinTs, media: { ...info.media } }))
    .sort((a, b) => (a.joinTs > b.joinTs) ? 1 : ((b.joinTs > a.joinTs) ? -1 : 0))
}

function findConsumerForTrack (peerId, mediaTag) {
  return consumers.find((c) => (c.appData.peerId === peerId &&
    c.appData.mediaTag === mediaTag))
}

//
// -- user interface --
//

export function getCamPausedState () {
  return !$('#local-cam-checkbox').checked
}

export function getMicPausedState () {
  return !$('#local-mic-checkbox').checked
}

export function getScreenPausedState () {
  return !$('#local-screen-checkbox').checked
}

export function getScreenAudioPausedState () {
  return !$('#local-screen-audio-checkbox').checked
}

export async function changeCamPaused () {
  if (getCamPausedState()) {
    pauseProducer(camVideoProducer)
    $('#local-cam-label').innerHTML = 'camera (paused)'
  } else {
    resumeProducer(camVideoProducer)
    $('#local-cam-label').innerHTML = 'camera'
  }
}

export async function changeMicPaused () {
  if (getMicPausedState()) {
    pauseProducer(camAudioProducer)
    $('#local-mic-label').innerHTML = 'mic (paused)'
  } else {
    resumeProducer(camAudioProducer)
    $('#local-mic-label').innerHTML = 'mic'
  }
}

export async function changeScreenPaused () {
  if (getScreenPausedState()) {
    pauseProducer(screenVideoProducer)
    $('#local-screen-label').innerHTML = 'screen (paused)'
  } else {
    resumeProducer(screenVideoProducer)
    $('#local-screen-label').innerHTML = 'screen'
  }
}

export async function changeScreenAudioPaused () {
  if (getScreenAudioPausedState()) {
    pauseProducer(screenAudioProducer)
    $('#local-screen-audio-label').innerHTML = 'screen (paused)'
  } else {
    await resumeProducer(screenAudioProducer)
    $('#local-screen-audio-label').innerHTML = 'screen'
  }
}

export async function updatePeersDisplay (peersInfo = lastPollSyncData,
  sortedPeers = sortPeers(peersInfo)) {
  log('demo-app', 'room state updated', peersInfo)

  $('#available-tracks').innerHTML = ''
  if (camVideoProducer) {
    $('#available-tracks')
      .appendChild(makeTrackControlEl('my', 'cam-video',
        peersInfo[myPeerId].media['cam-video']))
  }
  if (camAudioProducer) {
    $('#available-tracks')
      .appendChild(makeTrackControlEl('my', 'cam-audio',
        peersInfo[myPeerId].media['cam-audio']))
  }
  if (screenVideoProducer) {
    $('#available-tracks')
      .appendChild(makeTrackControlEl('my', 'screen-video',
        peersInfo[myPeerId].media['screen-video']))
  }
  if (screenAudioProducer) {
    $('#available-tracks')
      .appendChild(makeTrackControlEl('my', 'screen-audio',
        peersInfo[myPeerId].media['screen-audio']))
  }

  for (let peer of sortedPeers) {
    if (peer.id === myPeerId) {
      continue
    }
    for (let [mediaTag, info] of Object.entries(peer.media)) {
      $('#available-tracks')
        .appendChild(makeTrackControlEl(peer.id, mediaTag, info))
    }
  }
}

function makeTrackControlEl (peerName, mediaTag, mediaInfo) {
  let div = document.createElement('div'),
    peerId = (peerName === 'my' ? myPeerId : peerName),
    consumer = findConsumerForTrack(peerId, mediaTag)
  div.classList.add(`track-subscribe`)
  div.classList.add(`track-subscribe-${peerId}`)

  let sub = document.createElement('button')
  sub.classList.add('btn')
  sub.classList.add('btn-secondary')
  if (!consumer) {
    sub.innerHTML += '<i class="fas fa-plus-square"></i>'
    sub.onclick = () => subscribeToTrack(peerId, mediaTag)
  } else {
    sub.innerHTML += '<i class="fas fa-minus-square"></i>'
    sub.onclick = () => unsubscribeFromTrack(peerId, mediaTag)
    div.appendChild(sub)
  }
  div.appendChild(sub)

  let trackDescription = document.createElement('span')
  trackDescription.innerHTML = `${peerName} ${mediaTag}`
  div.appendChild(trackDescription)

  try {
    if (mediaInfo) {
      let producerPaused = mediaInfo.paused
      let prodPauseInfo = document.createElement('span')
      prodPauseInfo.innerHTML = producerPaused ? '[producer paused]'
        : '[producer playing]'
      div.appendChild(prodPauseInfo)
    }
  } catch (e) {
    console.error(e)
  }

  if (consumer) {
    let pause = document.createElement('span'),
      checkbox = document.createElement('input'),
      label = document.createElement('label')
    pause.classList.add('nowrap')
    checkbox.type = 'checkbox'
    checkbox.checked = !consumer.paused
    checkbox.onchange = async () => {
      if (checkbox.checked) {
        await resumeConsumer(consumer)
      } else {
        await pauseConsumer(consumer)
      }
      await updatePeersDisplay()
    }
    label.id = `consumer-stats-${consumer.id}`
    if (consumer.paused) {
      label.innerHTML = '[consumer paused]'
    } else {
      let stats = lastPollSyncData[myPeerId].stats[consumer.id],
        bitrate = '-'
      if (stats) {
        bitrate = Math.floor(stats.bitrate / 1000.0)
      }
      label.innerHTML = `[consumer playing ${bitrate} kb/s]`
    }
    pause.appendChild(checkbox)
    pause.appendChild(label)
    div.appendChild(pause)

    if (consumer.kind === 'video') {
      const remoteProducerInfo = document.createElement('span')
      remoteProducerInfo.classList.add('nowrap')
      remoteProducerInfo.classList.add('track-ctrl')
      remoteProducerInfo.id = `track-ctrl-${consumer.producerId}`
      div.appendChild(remoteProducerInfo)
      const videoInfo = document.createElement('span')
      videoInfo.classList.add('nowrap')
      videoInfo.classList.add('track-ctrl')
      videoInfo.id = `video-info-${consumer.producerId}`
      div.appendChild(videoInfo)
    }
  }

  return div
}

function addVideoAudio (consumer) {
  if (!(consumer && consumer.track)) {
    return
  }
  let el = document.createElement(consumer.kind)
  // set some attributes on our audio and video elements to make
  // mobile Safari happy. note that for audio to play you need to be
  // capturing from the mic/camera
  el.id = `track-${consumer.kind}-${consumer.producerId}`
  el.dataset.peerId = consumer.appData.peerId
  el.dataset.consumerId  = consumer.id
  el.dataset.kind = consumer.kind
  el.setAttribute('playsinline', true)
  if (consumer.kind === 'audio') {
    /* defer play on video, but not audio */
    el.setAttribute('autoplay', true)
  }
  $(`#remote-${consumer.kind}`).appendChild(el)
  el.srcObject = new MediaStream([consumer.track.clone()])
  el.consumer = consumer
  // let's "yield" and return before playing, rather than awaiting on
  // play() succeeding. play() will not succeed on a producer-paused
  // track until the producer unpauses.
  el.play()
    .then(() => {})
    .catch((e) => {
      err('demo-app', e)
    })
}

function removeVideoAudio (consumer) {
  document.querySelectorAll(consumer.kind).forEach((v) => {
    if (v.consumer === consumer) {
      v.parentNode.removeChild(v)
    }
  })
}

async function showCameraInfo () {
  let deviceId = await getCurrentDeviceId(),
    infoEl = $('#camera-info')
  if (!deviceId) {
    infoEl.innerHTML = ''
    return
  }
  let devices = await navigator.mediaDevices.enumerateDevices(),
    deviceInfo = devices.find((d) => d.deviceId === deviceId)
  infoEl.innerHTML = `
      ${deviceInfo.label}
      <button class="btn btn-secondary" onclick="Client.cycleCamera()"><i class="fas fa-random" title="Change Camera"></i></button>
  `
}

export async function getCurrentDeviceId () {
  if (!camVideoProducer) {
    return null
  }
  let deviceId = camVideoProducer.track.getSettings().deviceId
  if (deviceId) {
    return deviceId
  }
  // Firefox doesn't have deviceId in MediaTrackSettings object
  let track = localCam && localCam.getVideoTracks()[0]
  if (!track) {
    return null
  }
  let devices = await navigator.mediaDevices.enumerateDevices(),
    deviceInfo = devices.find((d) => d.label.startsWith(track.label))
  return deviceInfo.deviceId
}

function updateActiveSpeaker () {
  $$('.track-subscribe').forEach((el) => {
    el.classList.remove('active-speaker')
  })
  if (currentActiveSpeaker && currentActiveSpeaker.peerId) {
    $$(`.track-subscribe-${currentActiveSpeaker.peerId}`).forEach((el) => {
      el.classList.add('active-speaker')
    })
  }
}

function updateCamVideoProducerStatsDisplay () {
  let tracksEl = $('#camera-producer-stats')
  tracksEl.innerHTML = ''
  if (!camVideoProducer || camVideoProducer.paused) {
    return
  }
  makeProducerTrackSelector({
    internalTag: 'local-cam-tracks',
    container: tracksEl,
    peerId: myPeerId,
    producerId: camVideoProducer.id,
    currentLayer: camVideoProducer.maxSpatialLayer,
    layerSwitchFunc: (i) => {
      console.log('demo-app', 'client set layers for cam stream')
      camVideoProducer.setMaxSpatialLayer(i)
    }
  })
}

function updateScreenVideoProducerStatsDisplay () {
  let tracksEl = $('#screen-producer-stats')
  tracksEl.innerHTML = ''
  if (!screenVideoProducer || screenVideoProducer.paused) {
    return
  }
  makeProducerTrackSelector({
    internalTag: 'local-screen-tracks',
    container: tracksEl,
    peerId: myPeerId,
    producerId: screenVideoProducer.id,
    currentLayer: screenVideoProducer.maxSpatialLayer,
    layerSwitchFunc: (i) => {
      console.log('demo-app', 'client set layers for screen stream')
      screenVideoProducer.setMaxSpatialLayer(i)
    }
  })
}

function updateConsumersStatsDisplay () {
  try {
    for (let consumer of consumers) {
      let label = $(`#consumer-stats-${consumer.id}`)
      if (label) {
        if (consumer.paused) {
          label.innerHTML = '(consumer paused)'
        } else {
          let stats = lastPollSyncData[myPeerId].stats[consumer.id],
            bitrate = '-'
          if (stats) {
            bitrate = Math.floor(stats.bitrate / 1000.0)
          }
          label.innerHTML = `[consumer playing ${bitrate} kb/s]`
        }
      }

      let mediaInfo = lastPollSyncData[consumer.appData.peerId] &&
        lastPollSyncData[consumer.appData.peerId]
          .media[consumer.appData.mediaTag]
      if (mediaInfo && !mediaInfo.paused) {
        let tracksEl = $(`#track-ctrl-${consumer.producerId}`)
        if (tracksEl && lastPollSyncData[myPeerId]
          .consumerLayers[consumer.id]) {
          tracksEl.innerHTML = ''
          let currentLayer = lastPollSyncData[myPeerId]
            .consumerLayers[consumer.id].currentLayer
          makeProducerTrackSelector({
            internalTag: consumer.id,
            container: tracksEl,
            peerId: consumer.appData.peerId,
            producerId: consumer.producerId,
            currentLayer: currentLayer,
            layerSwitchFunc: (i) => {
              console.log('demo-app', 'ask server to set layers')
              sig('consumer-set-layers', {
                consumerId: consumer.id,
                spatialLayer: i
              }).then()
            }
          })
          /* video size, etc */
          const vidEl = $(`#track-video-${consumer.producerId}`)
          const vidInfoEl = $(`#video-info-${consumer.producerId}`)
          if (vidEl && vidInfoEl) {
            vidInfoEl.innerText  = `${vidEl.videoWidth}x${vidEl.videoHeight}`
          }
        }
      }
    }
  } catch (e) {
    log('demo-app', 'error while updating consumers stats display', e)
  }
}

function makeProducerTrackSelector ({
  internalTag, container, peerId, producerId,
  currentLayer, layerSwitchFunc
}) {
  try {
    let pollStats = lastPollSyncData[peerId] &&
      lastPollSyncData[peerId].stats[producerId]
    if (!pollStats) {
      return
    }

    let stats = [...Array.from(pollStats)]
      .sort((a, b) => a.rid > b.rid ? 1 : (a.rid < b.rid ? -1 : 0))
    let i = 0
    for (let s of stats) {
      let div = document.createElement('div'),
        radio = document.createElement('input'),
        label = document.createElement('label'),
        x = i
      radio.type = 'radio'
      radio.name = `radio-${internalTag}-${producerId}`
      radio.checked = !currentLayer ?
        (i === stats.length - 1) :
        (i === currentLayer)
      radio.onchange = () => layerSwitchFunc(x)
      let bitrate = Math.floor(s.bitrate / 1000)
      label.innerHTML = `${bitrate} kb/s`
      div.appendChild(radio)
      div.appendChild(label)
      container.appendChild(div)
      i++
    }
    if (i) {
      let txt = document.createElement('div')
      txt.innerHTML = 'tracks'
      container.insertBefore(txt, container.firstChild)
    }
  } catch (e) {
    log('demo-app', 'error while updating track stats display', e)
  }
}

function camEncodings () {
//
// encodings for outgoing video

  const userMediaConstraints = {
    video: {
      width: { ideal: 704 },
      height: { ideal: 576 },
      frameRate: { min: 10, ideal: 15, max: 15 },
    },
    audio: true
  }

  const encodings =
    [
      { maxBitrate: 128000, scaleResolutionDownBy: 4 },
      { maxBitrate: 384000, scaleResolutionDownBy: 2 },
      { maxBitrate: 512000, scaleResolutionDownBy: 1 },
    ]

  const userMediaConstraintsSafari = {
    video: {
      width: { ideal: 352 },
      height: { ideal: 288 },
      frameRate: { min: 10, ideal: 15, max: 15 },
    },
    audio: true
}

  const encodingsSafari =
    [
      { maxBitrate: 128000, scaleResolutionDownBy: 2 },
      { maxBitrate: 384000, scaleResolutionDownBy: 1 },
    ]
  const isSafari = navigator.vendor.toLowerCase().indexOf('apple') >= 0
  return isSafari
      ? { userMediaConstraintsSafari, encodingsSafari }
      : { userMediaConstraints, encodings }
}

function screenshareEncodings () {
  return null
}

//
// our "signaling" function -- just an http fetch
//

async function sig (endpoint, data, beacon) {
  try {
    let headers = { 'Content-Type': 'application/json' },
      body = JSON.stringify({ ...data, peerId: myPeerId })

    if (beacon) {
      navigator.sendBeacon('/signaling/' + endpoint, body)
      return null
    }

    let response = await fetch(
      '/signaling/' + endpoint, { method: 'POST', body, headers }
    )
    return await response.json()
  } catch (e) {
    console.error(e)
    return { error: e }
  }
}

//
// simple uuid helper function
//

function uuidv4 () {
  return ('111-111-1111').replace(/[018]/g, () =>
    (crypto.getRandomValues(new Uint8Array(1))[0] & 15).toString(16))
}

//
// promisified sleep
//

async function sleep (ms) {
  return new Promise((r) => setTimeout(() => r(), ms))
}
