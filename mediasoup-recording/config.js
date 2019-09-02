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
        // "rtx",
        // "bwe",
        // "score",
        // "simulcast",
        // "svc",
        // "sctp",
      ],
      // Minimum RTC port for ICE, DTLS, RTP, etc.
      rtcMinPort: 32256,
      // Maximum RTC port for ICE, DTLS, RTP, etc.
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
          clockRate: 90000,
          parameters: {
            "x-google-start-bitrate": 1000
          }
        }
      ]
    },

    // WebRtcTransportOptions
    webRtcTransport: {
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
      rtcpMux: true,
      comedia: false
    },

    recording: {
      get ip() {
        return module.exports.https.internalIp;
      },
      audioPort: 5006,
      videoPort: 5004
    },

    client: {
      // ProducerOptions
      videoProducer: {
        // Send video with 3 simulcast streams
        // RTCRtpEncodingParameters[]
        encodings: [
          {
            maxBitrate: 100000
            // maxFramerate: 15.0,
            // scaleResolutionDownBy: 1.5,
          },
          {
            maxBitrate: 300000
          },
          {
            maxBitrate: 900000
          }
        ],
        codecOptions: {
          videoGoogleStartBitrate: 1000
        }
      }
    }
  }
};
