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
        // "bwe",
        "dtls",
        "ice",
        "info",
        "rtcp",
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
    // -------
    // WARNING
    // These values MUST match those found in the input SDP file
    // -------
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
        },
        {
          kind: "video",
          mimeType: "video/H264",
          preferredPayloadType: 125,
          clockRate: 90000,
          parameters: {
            "level-asymmetry-allowed": 1,
            "packetization-mode": 1,
            "profile-level-id": "42e01f",
          },
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
        // Send video with 3 simulcast streams
        // RTCRtpEncodingParameters[]
        encodings: [
          {
            maxBitrate: 100000,
            // maxFramerate: 15.0,
            // scaleResolutionDownBy: 1.5,
          },
          {
            maxBitrate: 300000,
          },
          {
            maxBitrate: 900000,
          },
        ],
        codecOptions: {
          videoGoogleStartBitrate: 1000,
        },
      },
    },

    // Target IP and port for RTP recording
    recording: {
      ip: "127.0.0.1",

      // GStreamer's sdpdemux only supports RTCP = RTP + 1
      audioPort: 5004,
      audioPortRtcp: 5005,
      videoPort: 5006,
      videoPortRtcp: 5007,
    },
  },

  gstreamer: {
    logLevel: "4,GST_*:3", // $GST_DEBUG environment variable
  },
};
