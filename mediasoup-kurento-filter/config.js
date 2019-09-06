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
        // {
        //   kind: "video",
        //   mimeType: "video/H264",
        //   preferredPayloadType: 125,
        //   clockRate: 90000,
        //   parameters: {
        //     "level-asymmetry-allowed": 1,
        //     "packetization-mode": 1,
        //     "profile-level-id": "42e01f"
        //   }
        // }
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

      //[RTCP-MUX]
      rtcpMux: true,
      // rtcpMux: false,

      comedia: false
    },

    client: {
      // ProducerOptions
      videoProducer: {
        // RTCRtpEncodingParameters[]

        // Single video stream (no SVC)
        encodings: [
          { maxBitrate: 100000 },
        ],

        // Send video with 3 simulcast streams
        // encodings: [
        //   {
        //     maxBitrate: 100000
        //     // maxFramerate: 15.0,
        //     // scaleResolutionDownBy: 1.5,
        //   },
        //   { maxBitrate: 300000 },
        //   { maxBitrate: 900000 }
        // ],
        // codecOptions: {
        //   videoGoogleStartBitrate: 1000
        // }
      }
    }
  },

  kurento: {
    port: 8888,
    wsPath: "/kurento"
  }
};
