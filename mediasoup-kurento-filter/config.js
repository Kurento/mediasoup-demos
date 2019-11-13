module.exports = {
  https: {
    cert: "../cert/cert.pem",
    certKey: "../cert/key.pem",
    ip: "127.0.0.1",
    internalIp: "127.0.0.1",
    port: 8080,
    wsPath: "/server",
    wsPingInterval: 25000,
    wsPingTimeout: 5000
  },

  mediasoup: {
    // WorkerSettings
    worker: {
      // "debug", "warn", "error", "none"
      logLevel: "warn",
      logTags: [
        "info",
        "ice",
        "dtls",
        "rtp",
        "srtp",
        "rtcp"
        // "rtx", "bwe", "score", "simulcast", "svc", "sctp",
      ],
      rtcMinPort: 32256,
      rtcMaxPort: 65535
    },

    // RouterOptions
    router: {
      // RtpCodecCapability[]
      mediaCodecs: [
        {
          kind: "audio",
          mimeType: "audio/opus",
          preferredPayloadType: 111,
          clockRate: 48000,
          channels: 2
        },
        {
          kind: "video",
          mimeType: "video/VP8",
          preferredPayloadType: 96,
          clockRate: 90000
        }
      ]
    },

    // WebRtcTransportOptions
    webrtcTransport: {
      get listenIps() {
        return [{ ip: module.exports.https.internalIp, announcedIp: null }];
      },
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 600000,
      minimumAvailableOutgoingBitrate: 300000
    },

    // PlainRtpTransportOptions
    plainRtpTransport: {
      get listenIp() {
        return { ip: module.exports.https.internalIp, announcedIp: null };
      },
      rtcpMux: false
    },

    client: {
      // ProducerOptions
      videoProducer: {
        // Single video stream (no simulcast)
        // RTCRtpEncodingParameters[]
        encodings: [{ maxBitrate: 100000 }]
      }
    }
  },

  kurento: {
    ip: "127.0.0.1",
    port: 8888,
    wsPath: "/kurento"
  }
};
