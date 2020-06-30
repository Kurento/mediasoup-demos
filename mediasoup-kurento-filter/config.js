module.exports = {
  https: {
    cert: "../cert/cert.pem",
    certKey: "../cert/key.pem",
    port: 8080,
    wsPath: "/server",
    wsPingInterval: 25000,
    wsPingTimeout: 5000,
  },

  mediasoup: {
    // WorkerSettings
    worker: {
      logLevel: "debug", // "debug", "warn", "error", "none"
      logTags: [
        "bwe",
        "dtls",
        "ice",
        "info",
        // "rtcp",
        "rtp",
        // "rtx",
        // "score",
        // "sctp",
        // "simulcast",
        "srtp",
        // "svc"
      ],
      rtcMinPort: 32256,
      rtcMaxPort: 65535,
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
          channels: 2,
          parameters: {
            minptime: 10,
            useinbandfec: 1,
          },
        },
        {
          kind: "video",
          mimeType: "video/VP8",
          preferredPayloadType: 96,
          clockRate: 90000,
          rtcpFeedback: [
            { type: "goog-remb" },
            { type: "ccm", parameter: "fir" },
            { type: "nack" },
            { type: "nack", parameter: "pli" },
          ],
        },
      ],
    },

    // WebRtcTransportOptions
    webrtcTransport: {
      listenIps: [{ ip: "127.0.0.1", announcedIp: null }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 300000,
    },

    // PlainTransportOptions
    plainTransport: {
      listenIp: { ip: "127.0.0.1", announcedIp: null },
    },

    client: {
      // ProducerOptions
      videoProducer: {
        // Single video stream (no simulcast)
        // RTCRtpEncodingParameters[]
        encodings: [{ maxBitrate: 2000000 }],
      },
    },
  },

  kurento: {
    ip: "127.0.0.1",
    port: 8888,
    wsPath: "/kurento",
  },

  srtp: {
    // Required format: AES CM 128 bit (30 bytes or characters in plain text format)
    // Plain text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"
    keyBase64: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0",
  },
};
