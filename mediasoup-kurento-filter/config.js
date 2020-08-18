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
      // If running KMS from localhost or with Docker "host network", use the
      // localhost IP address.
      listenIp: { ip: "0.0.0.0", announcedIp: "127.0.0.1" },

      // If running KMS from a non-"host network" Linux Docker container, use
      // the Docker network gateway IP, which by default is "172.17.0.1".
      //listenIp: { ip: "0.0.0.0", announcedIp: "172.17.0.1" },

      // If running KMS from Docker for Mac or Windows, use the IP address that
      // results from resolving the hostname "host.docker.internal" from
      // *inside* the Docker container.
      // Also, "kurento.usingDockerForLinux" must be false.
      //listenIp: { ip: "0.0.0.0", announcedIp: "192.168.65.2" },
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

    // Set to false if running KMS from Docker for Mac or Windows.
    usingDockerForLinux: true,
  },

  srtp: {
    // Required format: AES CM 128 bit (30 bytes or characters in plain text format)
    // Plain text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"
    keyBase64: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0",
  },
};
