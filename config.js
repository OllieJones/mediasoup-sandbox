const THIS_IS_A_SERVER = (typeof window === 'undefined')
const config = {
  // http server ip, port, and peer timeout constant
  //
  httpIp: '0.0.0.0',
  httpPort: 3000,
  httpPeerStale: 15000,

  transportTrace: [/*'probation', 'bwe'*/],
  producerConsumerTrace: [/*'rtp', 'keyframe', */ 'nack', 'fir', 'pli'],

  mediasoup: {
    worker: {
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
      logLevel: 'debug',
      logTags: [
        'info',
        'ice',
        'dtls',
        'rtp',
        'srtp',
        'rtcp',
        'rtx',
        'bwe',
        'score',
        'simulcast',
        'svc'
      ],
    },
    router: {
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
        },
          /* some browsers can only handle the constrained baseline profile.
        {
          kind: 'video',
          mimeType: 'video/h264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '4d0032',
            'level-asymmetry-allowed': 1,
          },
        }, */
        {
          kind: 'video',
          mimeType: 'video/h264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
          },
        },
       /* {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {
            //                'x-google-start-bitrate': 1000
          },
        }, */
      ],
    },

    // rtp listenIps are the most important thing, below. you'll need
    // to set these appropriately for your network for the demo to
    // run anywhere but on localhost
    webRtcTransport: {
      listenIps: getListenIps(),
      initialAvailableOutgoingBitrate: 2_000_000,
    },
  },
}

if (THIS_IS_A_SERVER) {
  require('dotenv').config()
  // ssl certs. we'll start as http instead of https if we don't have
  // these
  config.sslCrt = process.env.HTTPS_CERT_FULLCHAIN || '../ssl/cert.pem'
  config.sslKey = process.env.HTTPS_CERT_PRIVKEY || '../ssl/key.pem'
}

function getListenIps () {
  const listenIps = []
  if (typeof window === 'undefined') {
    const os = require('os')
    const networkInterfaces = os.networkInterfaces()
    const ips = []
    if (networkInterfaces) {
      for (const [key, addresses] of Object.entries(networkInterfaces)) {
        addresses.forEach(address => {
          if (address.family === 'IPv4') {
            listenIps.push({ ip: address.address, announcedIp: null })
          }
          /* ignore link-local and other special ipv6 addresses.
           * https://www.iana.org/assignments/ipv6-address-space/ipv6-address-space.xhtml
           */
          else if (address.family === 'IPv6' && address.address[0] !== 'f') {
            listenIps.push({ ip: address.address, announcedIp: null })
          }
        })
      }
    }
  }
  if (listenIps.length === 0) {
    listenIps.push({ ip: '127.0.0.1', announcedIp: null })
  }
  return listenIps
}

module.exports = config
