"use strict";

// Log whole objects instead of giving up after two levels of nesting
require("util").inspect.defaultOptions.depth = null;

const CONFIG = require("./config");
const Express = require("express");
const Fs = require("fs");
const Https = require("https");
const KurentoClient = require("kurento-client");
const Mediasoup = require("mediasoup");
const MediasoupOrtc = require("mediasoup-client/lib/ortc");
const MediasoupRtpUtils = require("mediasoup-client/lib/handlers/sdp/plainRtpUtils");
const MediasoupSdpUtils = require("mediasoup-client/lib/handlers/sdp/commonUtils");
const SdpTransform = require("sdp-transform");
const SocketServer = require("socket.io");
const Util = require("util");

const CryptoSuiteKurento = "AES_128_CM_HMAC_SHA1_80";
const CryptoSuiteMediasoup = "AES_CM_128_HMAC_SHA1_80";
const CryptoSuiteSdp = "AES_CM_128_HMAC_SHA1_80";

// ----------------------------------------------------------------------------

// Application state
// =================

const global = {
  server: {
    expressApp: null,
    https: null,
    socket: null,
    socketServer: null,
  },

  mediasoup: {
    worker: null,
    router: null,

    // WebRTC connection with the browser
    webrtc: {
      recvTransport: null,
      audioProducer: null,
      videoProducer: null,

      sendTransport: null,
      audioConsumer: null,
      videoConsumer: null,
    },

    // RTP connection with Kurento
    rtp: {
      recvTransport: null,
      recvProducer: null,

      sendTransport: null,
      sendConsumer: null,
    },
  },

  kurento: {
    client: null,
    pipeline: null,
    filter: null,

    // RTP connection with mediasoup
    rtp: {
      recvEndpoint: null,
      sendEndpoint: null,
    },
  },
};

// ----------------------------------------------------------------------------

// Logging
// =======

// Send all logging to both console and WebSocket
for (const name of ["log", "info", "warn", "error"]) {
  const method = console[name];
  console[name] = function (...args) {
    method(...args);
    if (global.server.socket) {
      global.server.socket.emit("LOG", Util.format(...args));
    }
  };
}

// ----------------------------------------------------------------------------

// HTTPS server
// ============
{
  const expressApp = Express();
  global.server.expressApp = expressApp;
  expressApp.use("/", Express.static(__dirname));

  const https = Https.createServer(
    {
      cert: Fs.readFileSync(CONFIG.https.cert),
      key: Fs.readFileSync(CONFIG.https.certKey),
    },
    expressApp
  );
  global.server.https = https;

  https.on("listening", () => {
    console.log(
      `Web server is listening on https://localhost:${CONFIG.https.port}`
    );
  });
  https.on("error", (err) => {
    console.error("HTTPS error:", err.message);
  });
  https.on("tlsClientError", (err) => {
    if (err.message.includes("alert number 46")) {
      // Ignore: this is the client browser rejecting our self-signed certificate
    } else {
      console.error("TLS error:", err);
    }
  });
  https.listen(CONFIG.https.port);
}

// ----------------------------------------------------------------------------

// WebSocket server
// ================
{
  const socketServer = SocketServer(global.server.https, {
    path: CONFIG.https.wsPath,
    serveClient: false,
    pingTimeout: CONFIG.https.wsPingTimeout,
    pingInterval: CONFIG.https.wsPingInterval,
    transports: ["websocket"],
  });
  global.server.socketServer = socketServer;

  socketServer.on("connect", (socket) => {
    console.log(
      "WebSocket server connected, port: %s",
      socket.request.connection.remotePort
    );
    global.server.socket = socket;

    // Events sent by the client's "socket.io-promise" have the fixed name
    // "request", and a field "type" that we use as identifier
    socket.on("request", handleRequest);

    // Events sent by the client's "socket.io-client" have a name
    // that we use as identifier
    socket.on("WEBRTC_RECV_CONNECT", handleWebrtcRecvConnect);
    socket.on("WEBRTC_RECV_PRODUCE", handleWebrtcRecvProduce);
    socket.on("WEBRTC_SEND_CONNECT", handleWebrtcSendConnect);
    socket.on("DEBUG", handleDebug);
  });
}

// ----

async function handleRequest(request, callback) {
  let responseData = null;

  switch (request.type) {
    case "START_MEDIASOUP":
      responseData = await handleStartMediasoup();
      break;
    case "START_KURENTO":
      await handleStartKurento(request.enableSrtp);
      break;
    case "WEBRTC_RECV_START":
      responseData = await handleWebrtcRecvStart();
      break;
    case "WEBRTC_SEND_START":
      responseData = await handleWebrtcSendStart();
      break;
    case "WEBRTC_SEND_CONSUME":
      responseData = await handleWebrtcSendConsume(request.rtpCapabilities);
      break;
    default:
      console.warn("Invalid request type:", request.type);
      break;
  }

  callback({ type: request.type, data: responseData });
}

// ----------------------------------------------------------------------------

// Creates a mediasoup worker and router

async function handleStartMediasoup() {
  let worker;
  try {
    worker = await Mediasoup.createWorker(CONFIG.mediasoup.worker);
  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }
  global.mediasoup.worker = worker;

  worker.on("died", () => {
    console.error(
      "mediasoup worker died, exit in 3 seconds... [pid:%d]",
      worker.pid
    );
    setTimeout(() => process.exit(1), 3000);
  });

  console.log("mediasoup worker created [pid:%d]", worker.pid);

  let router;
  try {
    router = await worker.createRouter(CONFIG.mediasoup.router);
  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }
  global.mediasoup.router = router;

  // At this point, the computed "router.rtpCapabilities" includes the
  // router codecs enhanced with retransmission and RTCP capabilities,
  // and the list of RTP header extensions supported by mediasoup.

  console.log("mediasoup router created");

  console.log("mediasoup router RtpCapabilities:\n%O", router.rtpCapabilities);

  return router.rtpCapabilities;
}

// ----------------------------------------------------------------------------

// Creates a mediasoup WebRTC RECV transport

async function handleWebrtcRecvStart() {
  const router = global.mediasoup.router;

  let transport;
  try {
    transport = await router.createWebRtcTransport(
      CONFIG.mediasoup.webrtcTransport
    );
  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }
  global.mediasoup.webrtc.recvTransport = transport;

  console.log("mediasoup WebRTC RECV transport created");

  const webrtcTransportOptions = {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    sctpParameters: transport.sctpParameters,
  };

  console.log(
    "mediasoup WebRTC RECV TransportOptions:\n%O",
    webrtcTransportOptions
  );

  return webrtcTransportOptions;
}

// ----------------------------------------------------------------------------

// Creates a mediasoup WebRTC SEND transport

async function handleWebrtcSendStart() {
  const router = global.mediasoup.router;

  let transport;
  try {
    transport = await router.createWebRtcTransport(
      CONFIG.mediasoup.webrtcTransport
    );
  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }
  global.mediasoup.webrtc.sendTransport = transport;

  /*
  RTP: [mediasoup --> browser]
  RTCP Feedback (BWE): [browser --> mediasoup]
  RTCP BWE forwarding: [browser --> mediasoup --> Kurento]

  The browser receives video from mediasoup, and sends back its own bandwidth
  estimation (BWE) data. Here, we forward this data to the RTP side, i.e.
  the connection between mediasoup and Kurento. This way, the video encoder
  inside Kurento will be able to adapt its output bitrate.
  */
  await transport.enableTraceEvent(["bwe"]);
  transport.on("trace", async (trace) => {
    if (trace.type === "bwe") {
      const transport = global.mediasoup.rtp.recvTransport;
      if (transport) {
        console.log(
          "[BWE] Forward to Kurento, availableBitrate:",
          trace.info.availableBitrate
        );
        await transport.setMaxIncomingBitrate(trace.info.availableBitrate);
      }
    }
  });

  console.log("mediasoup WebRTC SEND transport created");

  const webrtcTransportOptions = {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    sctpParameters: transport.sctpParameters,
  };

  console.log(
    "mediasoup WebRTC SEND TransportOptions:\n%O",
    webrtcTransportOptions
  );

  return webrtcTransportOptions;
}

// ----------------------------------------------------------------------------

// Calls WebRtcTransport.connect() whenever the browser client part is ready

async function handleWebrtcRecvConnect(dtlsParameters) {
  const transport = global.mediasoup.webrtc.recvTransport;

  await transport.connect({ dtlsParameters });

  console.log("mediasoup WebRTC RECV transport connected");
}

// ----------------------------------------------------------------------------

// Calls WebRtcTransport.connect() whenever the browser client part is ready

async function handleWebrtcSendConnect(dtlsParameters) {
  const transport = global.mediasoup.webrtc.sendTransport;

  await transport.connect({ dtlsParameters });

  console.log("mediasoup WebRTC SEND transport connected");
}

// ----------------------------------------------------------------------------

// Calls WebRtcTransport.produce() to start receiving media from the browser

async function handleWebrtcRecvProduce(produceParameters, callback) {
  const transport = global.mediasoup.webrtc.recvTransport;

  const producer = await transport.produce(produceParameters);
  switch (producer.kind) {
    case "audio":
      global.mediasoup.webrtc.audioProducer = producer;
      break;
    case "video":
      global.mediasoup.webrtc.videoProducer = producer;
      break;
  }

  global.server.socket.emit("WEBRTC_RECV_PRODUCER_READY", producer.kind);

  console.log(
    "mediasoup WebRTC RECV producer created, kind: %s, type: %s, paused: %s",
    producer.kind,
    producer.type,
    producer.paused
  );

  console.log(
    "mediasoup WebRTC RECV producer RtpParameters:\n%O",
    producer.rtpParameters
  );

  callback(producer.id);
}

// ----------------------------------------------------------------------------

// Calls WebRtcTransport.consume() to start sending media to the browser

async function handleWebrtcSendConsume(rtpCapabilities) {
  const transport = global.mediasoup.webrtc.sendTransport;

  const producer = global.mediasoup.rtp.recvProducer;
  if (!producer) {
    console.error("BUG: The producer doesn't exist!");
    process.exit(1);
  }

  const consumer = await transport.consume({
    producerId: producer.id,
    rtpCapabilities: rtpCapabilities,
    paused: false,
  });
  global.mediasoup.webrtc.videoConsumer = consumer;

  console.log(
    "mediasoup WebRTC SEND consumer created, kind: %s, type: %s, paused: %s",
    consumer.kind,
    consumer.type,
    consumer.paused
  );

  console.log(
    "mediasoup WebRTC SEND consumer RtpParameters:\n%O",
    consumer.rtpParameters
  );

  const webrtcConsumerOptions = {
    id: consumer.id,
    producerId: consumer.producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  };

  return webrtcConsumerOptions;
}

// ----------------------------------------------------------------------------

async function handleStartKurento(enableSrtp) {
  // Start client connection to Kurento Media Server
  await startKurento();

  // Send media to Kurento
  await startKurentoRtpConsumer(enableSrtp);

  // Receive media from Kurento
  await startKurentoRtpProducer(enableSrtp);

  // Build the internal Kurento filter pipeline
  await startKurentoFilter();
}

// ----

async function startKurento() {
  const kurentoUrl = `ws://${CONFIG.kurento.ip}:${CONFIG.kurento.port}${CONFIG.kurento.wsPath}`;
  console.log("Connect with Kurento Media Server:", kurentoUrl);

  const kmsClient = new KurentoClient(kurentoUrl);
  global.kurento.client = kmsClient;
  console.log("Kurento client connected");

  const kmsPipeline = await kmsClient.create("MediaPipeline");
  global.kurento.pipeline = kmsPipeline;
  console.log("Kurento pipeline created");
}

// ----

// Helper function:
// Get mediasoup router's preferred PayloadType
function getMsPayloadType(mimeType) {
  const router = global.mediasoup.router;
  let pt = 0;

  const codec = router.rtpCapabilities.codecs.find(
    (c) => c.mimeType === mimeType
  );
  if (codec) {
    pt = codec.preferredPayloadType;
  }

  return pt;
}

// ----

// Helper function:
// Get mediasoup router's preferred HeaderExtension ID
function getMsHeaderExtId(kind, name) {
  const router = global.mediasoup.router;
  let id = 0;

  const ext = router.rtpCapabilities.headerExtensions.find(
    (e) => e.kind === kind && e.uri.includes(name)
  );
  if (ext) {
    id = ext.preferredId;
  }

  return id;
}

// ----

// Helper function:
// Get RtcpParameters (https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtcpParameters)
// from an SDP object obtained from `SdpTransform.parse()`.
// We need this because MediasoupRtpUtils has useful functions like
// `getRtpEncodings()`, but it lacks something like `getRtcpParameters()`.
function getRtcpParameters(sdpObject, kind) {
  const mediaObject = (sdpObject.media || []).find((m) => m.type === kind);
  if (!mediaObject) {
    throw new Error(`m=${kind} section not found`);
  }

  // Get CNAME
  const ssrcCname = (mediaObject.ssrcs || []).find(
    (s) => s.attribute && s.attribute === "cname"
  );
  const cname = ssrcCname && ssrcCname.value ? ssrcCname.value : null;

  // Get RTCP Reduced Size ("a=rtcp-rsize")
  const reducedSize = "rtcpRsize" in mediaObject;

  return { cname: cname, reducedSize: reducedSize };
}

// ----------------------------------------------------------------------------

async function startKurentoRtpConsumer(enableSrtp) {
  const msRouter = global.mediasoup.router;
  const kmsPipeline = global.kurento.pipeline;

  // mediasoup RTP transport (send media to Kurento)
  // -----------------------------------------------

  const msTransport = await msRouter.createPlainTransport({
    // COMEDIA mode must be disabled here: the corresponding Kurento RtpEndpoint
    // is going to act as receive-only peer, thus it will never send RTP data
    // to mediasoup, which is a mandatory condition to use COMEDIA
    comedia: false,

    // Kurento RtpEndpoint doesn't support RTP/RTCP multiplexing ("a=rtcp-mux" in SDP)
    rtcpMux: false,

    // Enable SRTP if requested
    enableSrtp: enableSrtp,
    srtpCryptoSuite: CryptoSuiteMediasoup,

    ...CONFIG.mediasoup.plainTransport,
  });
  global.mediasoup.rtp.sendTransport = msTransport;

  /*
  RTP: [mediasoup --> Kurento]
  RTCP Feedback (BWE): [Kurento --> mediasoup]
  RTCP BWE forwarding: [Kurento --> mediasoup --> browser]

  Kurento receives video from mediasoup, and sends back its own bandwidth
  estimation (BWE) data. Here, we forward this data to the WebRTC side, i.e.
  the connection between browser and mediasoup. This way, the video encoder
  inside the browser will be able to adapt its output bitrate.
  */
  await msTransport.enableTraceEvent(["bwe"]);
  msTransport.on("trace", async (trace) => {
    if (trace.type === "bwe") {
      const transport = global.mediasoup.webrtc.recvTransport;
      if (transport) {
        console.log(
          "[BWE] Forward to browser, availableBitrate:",
          trace.info.availableBitrate
        );
        await transport.setMaxIncomingBitrate(trace.info.availableBitrate);
      }
    }
  });

  console.log(
    "mediasoup RTP SEND transport created: %s:%d (%s)",
    msTransport.tuple.localIp,
    msTransport.tuple.localPort,
    msTransport.tuple.protocol
  );

  console.log(
    "mediasoup RTCP SEND transport created: %s:%d (%s)",
    msTransport.rtcpTuple.localIp,
    msTransport.rtcpTuple.localPort,
    msTransport.rtcpTuple.protocol
  );

  // mediasoup RTP consumer (send media to Kurento)
  // ----------------------------------------------

  const msPayloadType = getMsPayloadType("video/VP8");
  const msHeaderExtId = getMsHeaderExtId("video", "abs-send-time");

  // Create RtpCapabilities for the mediasoup RTP consumer. These values must
  // match those communicated to Kurento through the SDP Offer message.
  //
  // RtpCapabilities (https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtpCapabilities)
  const kmsRtpCapabilities = {
    codecs: [
      // RtpCodecCapability (https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtpCodecCapability)
      {
        kind: "video",
        mimeType: "video/VP8",
        preferredPayloadType: msPayloadType,
        clockRate: 90000,
        parameters: {},
        rtcpFeedback: [
          { type: "goog-remb" },
          { type: "ccm", parameter: "fir" },
          { type: "nack" },
          { type: "nack", parameter: "pli" },
        ],
      },
    ],
    headerExtensions: [
      {
        kind: "video",
        uri: "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
        preferredId: msHeaderExtId,
        preferredEncrypt: false,
        direction: "sendrecv",
      },
    ],
  };

  try {
    MediasoupOrtc.validateRtpCapabilities(kmsRtpCapabilities);
  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }

  console.log("Kurento RTP RECV RtpCapabilities:\n%O", kmsRtpCapabilities);

  const msConsumer = await msTransport.consume({
    producerId: global.mediasoup.webrtc.videoProducer.id,
    rtpCapabilities: kmsRtpCapabilities,
    paused: false,
  });
  global.mediasoup.rtp.sendConsumer = msConsumer;

  console.log(
    "mediasoup RTP SEND consumer created, kind: %s, type: %s, paused: %s, SSRC: %s CNAME: %s",
    msConsumer.kind,
    msConsumer.type,
    msConsumer.paused,
    msConsumer.rtpParameters.encodings[0].ssrc,
    msConsumer.rtpParameters.rtcp.cname
  );

  console.log(
    "mediasoup RTP SEND consumer RtpParameters:\n%O",
    msConsumer.rtpParameters
  );

  // Kurento RtpEndpoint (receive media from mediasoup)
  // --------------------------------------------------

  // When receiving from mediasoup, we must use mediasoup preferred identifiers
  const sdpPayloadType = getMsPayloadType("video/VP8");
  const sdpHeaderExtId = getMsHeaderExtId("video", "abs-send-time");

  const sdpListenIp = msTransport.tuple.localIp;
  const sdpListenPort = msTransport.tuple.localPort;
  const sdpListenPortRtcp = msTransport.rtcpTuple.localPort;

  const sdpSsrc = msConsumer.rtpParameters.encodings[0].ssrc;
  const sdpCname = msConsumer.rtpParameters.rtcp.cname;

  let sdpProtocol = "RTP/AVPF";
  let sdpCryptoLine = "";
  let kmsCrypto = undefined;

  if (enableSrtp) {
    // Use SRTP protocol
    sdpProtocol = "RTP/SAVPF";

    // Kurento uses this to decrypt SRTP/SRTCP coming in from mediasoup
    const keyBase64 = msTransport.srtpParameters.keyBase64;
    sdpCryptoLine = `a=crypto:2 ${CryptoSuiteSdp} inline:${keyBase64}|2^31|1:1\r\n`;

    // Kurento uses this to encrypt SRTCP going out to mediasoup
    kmsCrypto = KurentoClient.getComplexType("SDES")({
      keyBase64: CONFIG.srtp.keyBase64,
      crypto: CryptoSuiteKurento,
    });
  }

  // SDP Offer for Kurento RtpEndpoint
  // prettier-ignore
  const kmsSdpOffer =
    "v=0\r\n" +
    `o=- 0 0 IN IP4 ${sdpListenIp}\r\n` +
    "s=-\r\n" +
    `c=IN IP4 ${sdpListenIp}\r\n` +
    "t=0 0\r\n" +
    `m=video ${sdpListenPort} ${sdpProtocol} ${sdpPayloadType}\r\n` +
    `a=extmap:${sdpHeaderExtId} http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\r\n` +
    "a=sendonly\r\n" +
    `a=rtcp:${sdpListenPortRtcp}\r\n` +
    `${sdpCryptoLine}` +
    `a=rtpmap:${sdpPayloadType} VP8/90000\r\n` +
    `a=rtcp-fb:${sdpPayloadType} goog-remb\r\n` +
    `a=rtcp-fb:${sdpPayloadType} ccm fir\r\n` +
    `a=rtcp-fb:${sdpPayloadType} nack\r\n` +
    `a=rtcp-fb:${sdpPayloadType} nack pli\r\n` +
    `a=ssrc:${sdpSsrc} cname:${sdpCname}\r\n` +
    "";

  const kmsRtpEndpoint = await kmsPipeline.create("RtpEndpoint", {
    crypto: kmsCrypto,
  });
  global.kurento.rtp.recvEndpoint = kmsRtpEndpoint;

  console.log("SDP Offer from App to Kurento RTP RECV:\n%s", kmsSdpOffer);
  const kmsSdpAnswer = await kmsRtpEndpoint.processOffer(kmsSdpOffer);
  console.log("SDP Answer from Kurento RTP RECV to App:\n%s", kmsSdpAnswer);

  // NOTE: A real application would need to parse this SDP Answer and adapt to
  // the parameters given in it, following the SDP Offer/Answer Model.
  // For example, if Kurento didn't support NACK PLI, then it would reply
  // without that attribute in the SDP Answer, and this app should notice it and
  // reconfigure accordingly.
  // Here, we'll just assume that the SDP Answer from Kurento is accepting all
  // of our medias, formats, and options.

  const kmsSdpAnswerObj = SdpTransform.parse(kmsSdpAnswer);

  console.log("Kurento RTP RECV SDP:\n%O", kmsSdpAnswerObj);

  // Get the Kurento RTP/RTCP listening port(s) from the Kurento SDP Answer

  const mediaObj = (kmsSdpAnswerObj.media || []).find(
    (m) => m.type === "video"
  );
  if (!mediaObj) {
    throw new Error("m=video section not found");
  }

  const connectionObj = mediaObj.connection || kmsSdpAnswerObj.connection;

  let kmsIp;
  if (CONFIG.kurento.usingDockerForLinux) {
    // On Linux, the host can reach private Docker container's IP address
    // directly, so the value from the SDP connection can be used.
    kmsIp = connectionObj.ip;
  }
  else {
    // When running KMS from Docker for Mac or Windows, the host doesn't have
    // direct access to container's private IP address (because there is
    // actually a virtual machine in between). In this situation, ignore the SDP
    // connection's address and instead use the IP address given by the user
    // config.
    kmsIp = CONFIG.kurento.ip;
  }

  const kmsPortRtp = mediaObj.port;
  let kmsPortRtcp = kmsPortRtp + 1;
  if ("rtcp" in mediaObj) {
    // If "a=rtcp:<Port>" is found in the SDP Answer
    kmsPortRtcp = mediaObj.rtcp.port;
  }

  console.log(`Kurento video RTP listening on ${kmsIp}:${kmsPortRtp}`);
  console.log(`Kurento video RTCP listening on ${kmsIp}:${kmsPortRtcp}`);

  // Check if Kurento IP address is actually a localhost address, and in that
  // case use "127.0.0.1" instead. This is needed to ensure that the source IP
  // of RTP packets matches with the IP that is given here to connect().
  // Uses `os.networkInterfaces()` (https://nodejs.org/api/os.html#os_os_networkinterfaces)
  // to search for the Kurento IP address in each of the local interfaces.
  if (
    Object.values(require("os").networkInterfaces()).some((iface) =>
      iface.some((netaddr) => netaddr.address === kmsIp)
    )
  ) {
    kmsIp = "127.0.0.1";
  }

  // Connect the mediasoup transport to enable sending (S)RTP/RTCP and receiving
  // (S)RTCP packets to/from Kurento

  let srtpParameters = undefined;
  if (enableSrtp) {
    srtpParameters = {
      cryptoSuite: CryptoSuiteMediasoup,
      keyBase64: CONFIG.srtp.keyBase64,
    };
  }

  await msTransport.connect({
    ip: kmsIp,
    port: kmsPortRtp,
    rtcpPort: kmsPortRtcp,
    srtpParameters: srtpParameters,
  });

  console.log(
    "mediasoup RTP SEND transport connected: %s:%d <--> %s:%d (%s)",
    msTransport.tuple.localIp,
    msTransport.tuple.localPort,
    msTransport.tuple.remoteIp,
    msTransport.tuple.remotePort,
    msTransport.tuple.protocol
  );

  console.log(
    "mediasoup RTCP SEND transport connected: %s:%d <--> %s:%d (%s)",
    msTransport.rtcpTuple.localIp,
    msTransport.rtcpTuple.localPort,
    msTransport.rtcpTuple.remoteIp,
    msTransport.rtcpTuple.remotePort,
    msTransport.rtcpTuple.protocol
  );
}

// ----------------------------------------------------------------------------

async function startKurentoRtpProducer(enableSrtp) {
  const msRouter = global.mediasoup.router;
  const kmsPipeline = global.kurento.pipeline;

  // mediasoup RTP transport (receive media from Kurento)
  // ----------------------------------------------------

  const msTransport = await msRouter.createPlainTransport({
    // There is no need to `connect()` this transport: with COMEDIA enabled,
    // mediasoup waits until Kurento starts sending RTP, to detect Kurento's
    // outbound RTP and RTCP ports.
    comedia: true,

    // Kurento RtpEndpoint doesn't support RTP/RTCP multiplexing ("a=rtcp-mux" in SDP)
    rtcpMux: false,

    // Enable SRTP if requested
    enableSrtp: enableSrtp,
    srtpCryptoSuite: CryptoSuiteMediasoup,

    ...CONFIG.mediasoup.plainTransport,
  });
  global.mediasoup.rtp.recvTransport = msTransport;

  console.log(
    "mediasoup RTP RECV transport created: %s:%d (%s)",
    msTransport.tuple.localIp,
    msTransport.tuple.localPort,
    msTransport.tuple.protocol
  );

  console.log(
    "mediasoup RTCP RECV transport created: %s:%d (%s)",
    msTransport.rtcpTuple.localIp,
    msTransport.rtcpTuple.localPort,
    msTransport.rtcpTuple.protocol
  );

  // COMEDIA is enabled, so the transport connection will happen asynchronously

  msTransport.on("tuple", (tuple) => {
    console.log(
      "mediasoup RTP RECV transport connected: %s:%d <--> %s:%d (%s)",
      tuple.localIp,
      tuple.localPort,
      tuple.remoteIp,
      tuple.remotePort,
      tuple.protocol
    );
  });

  msTransport.on("rtcptuple", (rtcpTuple) => {
    console.log(
      "mediasoup RTCP RECV transport connected: %s:%d <--> %s:%d (%s)",
      rtcpTuple.localIp,
      rtcpTuple.localPort,
      rtcpTuple.remoteIp,
      rtcpTuple.remotePort,
      rtcpTuple.protocol
    );
  });

  // Kurento RtpEndpoint (send media to mediasoup)
  // ---------------------------------------------

  // When sending to mediasoup, we can choose our own identifiers;
  // we choose the defaults from mediasoup just for convenience
  const sdpPayloadType = getMsPayloadType("video/VP8");
  const sdpHeaderExtId = getMsHeaderExtId("video", "abs-send-time");

  const sdpListenIp = msTransport.tuple.localIp;
  const sdpListenPort = msTransport.tuple.localPort;
  const sdpListenPortRtcp = msTransport.rtcpTuple.localPort;

  let sdpProtocol = "RTP/AVPF";
  let sdpCryptoLine = "";
  let kmsCrypto = undefined;

  if (enableSrtp) {
    // Use SRTP protocol
    sdpProtocol = "RTP/SAVPF";

    // Kurento uses this to decrypt SRTCP coming in from mediasoup
    const keyBase64 = msTransport.srtpParameters.keyBase64;
    sdpCryptoLine = `a=crypto:2 ${CryptoSuiteSdp} inline:${keyBase64}|2^31|1:1\r\n`;

    // Kurento uses this to encrypt SRTP/SRTCP going out to mediasoup
    kmsCrypto = KurentoClient.getComplexType("SDES")({
      keyBase64: CONFIG.srtp.keyBase64,
      crypto: CryptoSuiteKurento,
    });
  }

  // SDP Offer for Kurento RtpEndpoint
  // prettier-ignore
  const kmsSdpOffer =
    "v=0\r\n" +
    `o=- 0 0 IN IP4 ${sdpListenIp}\r\n` +
    "s=-\r\n" +
    `c=IN IP4 ${sdpListenIp}\r\n` +
    "t=0 0\r\n" +
    `m=video ${sdpListenPort} ${sdpProtocol} ${sdpPayloadType}\r\n` +
    `a=extmap:${sdpHeaderExtId} http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\r\n` +
    "a=recvonly\r\n" +
    `a=rtcp:${sdpListenPortRtcp}\r\n` +
    `${sdpCryptoLine}` +
    `a=rtpmap:${sdpPayloadType} VP8/90000\r\n` +
    `a=rtcp-fb:${sdpPayloadType} goog-remb\r\n` +
    `a=rtcp-fb:${sdpPayloadType} ccm fir\r\n` +
    `a=rtcp-fb:${sdpPayloadType} nack\r\n` +
    `a=rtcp-fb:${sdpPayloadType} nack pli\r\n` +
    "";

  const kmsRtpEndpoint = await kmsPipeline.create("RtpEndpoint", {
    crypto: kmsCrypto,
  });
  global.kurento.rtp.sendEndpoint = kmsRtpEndpoint;

  // Set maximum bitrate higher than default of 500 kbps
  await kmsRtpEndpoint.setMaxVideoSendBandwidth(2000); // Send max 2 mbps

  console.log("SDP Offer from App to Kurento RTP SEND:\n%s", kmsSdpOffer);
  const kmsSdpAnswer = await kmsRtpEndpoint.processOffer(kmsSdpOffer);
  console.log("SDP Answer from Kurento RTP SEND to App:\n%s", kmsSdpAnswer);

  // NOTE: A real application would need to parse this SDP Answer and adapt to
  // the parameters given in it, following the SDP Offer/Answer Model.
  // For example, if Kurento didn't support NACK PLI, then it would reply
  // without that attribute in the SDP Answer, and this app should notice it and
  // reconfigure accordingly.
  // Here, we'll just assume that the SDP Answer from Kurento is accepting all
  // of our medias, formats, and options.

  const kmsSdpAnswerObj = SdpTransform.parse(kmsSdpAnswer);

  console.log("Kurento RTP SEND SDP:\n%O", kmsSdpAnswerObj);

  // Build an RtpParameters from the Kurento SDP Answer,
  // this gives us the Kurento RTP stream's SSRC, payload type, etc.

  const kmsRtpCapabilities = MediasoupSdpUtils.extractRtpCapabilities({
    sdpObject: kmsSdpAnswerObj,
  });

  try {
    MediasoupOrtc.validateRtpCapabilities(kmsRtpCapabilities);
  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }

  console.log("Kurento RTP SEND RtpCapabilities:\n%O", kmsRtpCapabilities);

  const msExtendedRtpCapabilities = MediasoupOrtc.getExtendedRtpCapabilities(
    global.mediasoup.router.rtpCapabilities,
    kmsRtpCapabilities
  );

  console.log(
    "Kurento RTP SEND ExtendedRtpCapabilities:\n%O",
    msExtendedRtpCapabilities
  );

  const kmsRtpSendParameters = MediasoupOrtc.getSendingRtpParameters(
    "video",
    msExtendedRtpCapabilities
  );

  // `getSendingRtpParameters()` leaves empty "mid", "encodings", and "rtcp"
  // fields, so we have to fill those.
  {
    // TODO: "mid"
    kmsRtpSendParameters.mid = undefined;

    kmsRtpSendParameters.encodings = MediasoupRtpUtils.getRtpEncodings({
      sdpObject: kmsSdpAnswerObj,
      kind: "video",
    });

    kmsRtpSendParameters.rtcp = getRtcpParameters(kmsSdpAnswerObj, "video");
  }

  console.log("Kurento RTP SEND RtpParameters:\n%O", kmsRtpSendParameters);

  // mediasoup RTP producer (receive media from Kurento)
  // ---------------------------------------------------

  let msProducer;
  try {
    msProducer = await msTransport.produce({
      kind: "video",
      rtpParameters: kmsRtpSendParameters,
      paused: false,
    });
  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }
  global.mediasoup.rtp.recvProducer = msProducer;

  console.log(
    "mediasoup RTP RECV producer created, kind: %s, type: %s, paused: %s",
    msProducer.kind,
    msProducer.type,
    msProducer.paused
  );

  console.log(
    "mediasoup RTP RECV producer RtpParameters:\n%O",
    msProducer.rtpParameters
  );

  // Connect the mediasoup transport to enable receiving (S)RTP/RTCP and sending
  // (S)RTCP packets from/to Kurento

  let srtpParameters = undefined;
  if (enableSrtp) {
    srtpParameters = {
      cryptoSuite: CryptoSuiteMediasoup,
      keyBase64: CONFIG.srtp.keyBase64,
    };

    await msTransport.connect({
      srtpParameters: srtpParameters,
    });
  }
}

// ----------------------------------------------------------------------------

async function startKurentoFilter() {
  const kmsPipeline = global.kurento.pipeline;
  const recvEndpoint = global.kurento.rtp.recvEndpoint;
  const sendEndpoint = global.kurento.rtp.sendEndpoint;

  const filter = await kmsPipeline.create("GStreamerFilter", {
    command: "videobalance saturation=0.0",
  });
  global.kurento.filter = filter;

  await recvEndpoint.connect(filter);
  await filter.connect(sendEndpoint);
}

// ----------------------------------------------------------------------------

async function handleDebug() {
  console.log(
    "[DEBUG] mediasoup RTP SEND transport stats (send to Kurento):\n",
    await global.mediasoup.rtp.sendTransport.getStats()
  );
  console.log(
    "[DEBUG] mediasoup RTP SEND consumer stats (send to Kurento):\n",
    await global.mediasoup.rtp.sendConsumer.getStats()
  );
  console.log(
    "[DEBUG] mediasoup RTP RECV transport stats (receive from Kurento):\n",
    await global.mediasoup.rtp.recvTransport.getStats()
  );
  console.log(
    "[DEBUG] mediasoup RTP RECV producer stats (receive from Kurento):\n",
    await global.mediasoup.rtp.recvProducer.getStats()
  );
}

// ----------------------------------------------------------------------------
