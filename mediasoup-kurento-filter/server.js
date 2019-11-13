"use strict";

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

// ----------------------------------------------------------------------------

// Application state
// =================

const global = {
  server: {
    expressApp: null,
    https: null,
    socket: null,
    socketServer: null
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
      videoConsumer: null
    },

    // RTP connection with Kurento
    rtp: {
      recvTransport: null,
      recvProducer: null,

      sendTransport: null,
      sendConsumer: null
    }
  },

  kurento: {
    client: null,
    pipeline: null,
    filter: null,

    // RTP connection with mediasoup
    rtp: {
      recvEndpoint: null,
      sendEndpoint: null
    }
  }
};

// ----------------------------------------------------------------------------

// Logging
// =======

["log", "info", "warn", "error"].forEach(function(name) {
  const method = console[name];
  console[name] = function(...args) {
    method(...args);
    if (global.server.socket) {
      global.server.socket.emit("SERVER_LOG", Util.format(...args));
    }
  };
});

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
      key: Fs.readFileSync(CONFIG.https.certKey)
    },
    expressApp
  );
  global.server.https = https;

  https.on("listening", () => {
    console.log("Web server is running, port:", CONFIG.https.port);
  });
  https.on("error", err => {
    console.error("HTTPS error:", err.message);
  });
  https.on("tlsClientError", err => {
    console.error("TLS error:", err.message);
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
    transports: ["websocket"]
  });
  global.server.socketServer = socketServer;

  socketServer.on("connect", socket => {
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
    socket.on("CLIENT_CONNECT_RECV_TRANSPORT", handleConnectRecvTransport);
    socket.on("CLIENT_CONNECT_SEND_TRANSPORT", handleConnectSendTransport);
    socket.on("CLIENT_START_RECV_PRODUCER", handleStartRecvProducer);
    socket.on("CLIENT_DEBUG", handleDebug);
  });
}

// ----

async function handleRequest(request, callback) {
  let responseData = null;

  switch (request.type) {
    case "CLIENT_START_MEDIASOUP":
      responseData = await handleStartMediasoup();
      break;
    case "CLIENT_START_RECV_TRANSPORT":
      responseData = await handleStartRecvTransport();
      break;
    case "CLIENT_START_KURENTO":
      await handleStartKurento();
      break;
    case "CLIENT_START_SEND_TRANSPORT":
      responseData = await handleStartSendTransport();
      break;
    case "CLIENT_START_SEND_CONSUMER":
      responseData = await handleStartSendConsumer(request.rtpCapabilities);
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
  const worker = await Mediasoup.createWorker(CONFIG.mediasoup.worker);
  global.mediasoup.worker = worker;

  worker.on("died", () => {
    console.error(
      "mediasoup worker died, exit in 3 seconds... [pid:%d]",
      worker.pid
    );
    setTimeout(() => process.exit(1), 3000);
  });

  console.log("mediasoup worker created [pid:%d]", worker.pid);

  const router = await worker.createRouter(CONFIG.mediasoup.router);
  global.mediasoup.router = router;

  // At this point, the computed router.rtpCapabilities includes the
  // router codecs enhanced with retransmission and RTCP capabilities,
  // and the list of RTP header extensions supported by mediasoup.

  console.log("mediasoup router created");

  // Uncomment for debug
  // console.log("rtpCapabilities:\n%s", JSON.stringify(router.rtpCapabilities, null, 2));

  return router.rtpCapabilities;
}

// ----------------------------------------------------------------------------

// Creates a mediasoup WebRTC RECV transport

async function handleStartRecvTransport() {
  const router = global.mediasoup.router;

  const webrtcTransport = await router.createWebRtcTransport(
    CONFIG.mediasoup.webrtcTransport
  );
  global.mediasoup.webrtc.recvTransport = webrtcTransport;

  console.log("mediasoup WebRTC RECV transport created");

  const webrtcTransportOptions = {
    id: webrtcTransport.id,
    iceParameters: webrtcTransport.iceParameters,
    iceCandidates: webrtcTransport.iceCandidates,
    dtlsParameters: webrtcTransport.dtlsParameters,
    sctpParameters: webrtcTransport.sctpParameters
  };

  // Uncomment for debug
  // console.log("webrtcTransportOptions:\n%s", JSON.stringify(webrtcTransportOptions, null, 2));

  return webrtcTransportOptions;
}

// ----------------------------------------------------------------------------

// Creates a mediasoup WebRTC SEND transport

async function handleStartSendTransport() {
  const router = global.mediasoup.router;

  const webrtcTransport = await router.createWebRtcTransport(
    CONFIG.mediasoup.webrtcTransport
  );
  global.mediasoup.webrtc.sendTransport = webrtcTransport;

  console.log("mediasoup WebRTC SEND transport created");

  const webrtcTransportOptions = {
    id: webrtcTransport.id,
    iceParameters: webrtcTransport.iceParameters,
    iceCandidates: webrtcTransport.iceCandidates,
    dtlsParameters: webrtcTransport.dtlsParameters,
    sctpParameters: webrtcTransport.sctpParameters
  };

  // Uncomment for debug
  // console.log("webrtcTransportOptions:\n%s", JSON.stringify(webrtcTransportOptions, null, 2));

  return webrtcTransportOptions;
}

// ----------------------------------------------------------------------------

// Calls WebRtcTransport.connect() whenever the browser client part is ready

async function handleConnectRecvTransport(dtlsParameters) {
  const webrtcTransport = global.mediasoup.webrtc.recvTransport;

  await webrtcTransport.connect({ dtlsParameters });

  console.log("mediasoup WebRTC RECV transport connected");
}

// ----------------------------------------------------------------------------

// Calls WebRtcTransport.connect() whenever the browser client part is ready

async function handleConnectSendTransport(dtlsParameters) {
  const webrtcTransport = global.mediasoup.webrtc.sendTransport;

  await webrtcTransport.connect({ dtlsParameters });

  console.log("mediasoup WebRTC SEND transport connected");
}

// ----------------------------------------------------------------------------

// Calls WebRtcTransport.produce() to start receiving media from the browser

async function handleStartRecvProducer(produceParameters, callback) {
  const webrtcTransport = global.mediasoup.webrtc.recvTransport;

  const producer = await webrtcTransport.produce(produceParameters);
  switch (producer.kind) {
    case "audio":
      global.mediasoup.webrtc.audioProducer = producer;
      break;
    case "video":
      global.mediasoup.webrtc.videoProducer = producer;
      break;
  }

  console.log(
    "mediasoup WebRTC RECV producer created, kind: %s, type: %s, paused: %s",
    producer.kind,
    producer.type,
    producer.paused
  );

  // Uncomment for debug
  // console.log("rtpParameters:\n%s", JSON.stringify(producer.rtpParameters, null, 2));

  callback(producer.id);
}

// ----------------------------------------------------------------------------

// Calls WebRtcTransport.consume() to start sending media to the browser

async function handleStartSendConsumer(rtpCapabilities) {
  const webrtcTransport = global.mediasoup.webrtc.sendTransport;

  const producer = global.mediasoup.rtp.recvProducer;
  if (!producer) {
    console.error("BUG: The producer doesn't exist!");
    process.exit(1);
  }

  const consumer = await webrtcTransport.consume({
    producerId: producer.id,
    rtpCapabilities: rtpCapabilities,
    paused: false
  });
  global.mediasoup.webrtc.videoConsumer = consumer;

  console.log(
    "mediasoup WebRTC SEND consumer created, kind: %s, type: %s, paused: %s",
    consumer.kind,
    consumer.type,
    consumer.paused
  );

  // Uncomment for debug
  // console.log("rtpParameters:\n%s", JSON.stringify(consumer.rtpParameters, null, 2));

  const webrtcConsumerOptions = {
    id: consumer.id,
    producerId: consumer.producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters
  };

  return webrtcConsumerOptions;
}

// ----------------------------------------------------------------------------

async function handleStartKurento() {
  // Start client connection to Kurento Media Server
  await startKurento();

  // Send media to Kurento
  await startKurentoRtpConsumer();

  // Receive media from Kurento
  await startKurentoRtpProducer();

  // Build the internal Kurento filter pipeline
  await startKurentoFilter();
}

// ----

async function startKurento() {
  const kurentoUrl = `ws://${CONFIG.kurento.ip}:${CONFIG.kurento.port}${CONFIG.kurento.wsPath}`;
  console.log("Connect with Kurento Media Server:", kurentoUrl);

  const client = new KurentoClient(kurentoUrl);
  global.kurento.client = client;
  console.log("Kurento client connected");

  const pipeline = await client.create("MediaPipeline");
  global.kurento.pipeline = pipeline;
  console.log("Kurento pipeline created");
}

// ----

// Helper function.
// Get mediasoup PayloadType for the given kind ("video", "audio").
function getMsPayloadType(kind) {
  let msPayloadType = 0;

  const codec = CONFIG.mediasoup.router.mediaCodecs.find(c => c.kind === kind);
  if (codec) {
    msPayloadType = codec.preferredPayloadType;
  }

  return msPayloadType;
}

// ----

async function startKurentoRtpConsumer() {
  // mediasoup RTP transport (sends to Kurento)
  // ------------------------------------------

  const msRouter = global.mediasoup.router;
  const msTransport = await msRouter.createPlainRtpTransport({
    comedia: false,
    ...CONFIG.mediasoup.plainRtpTransport
  });
  global.mediasoup.rtp.sendTransport = msTransport;

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

  // mediasoup RTP consumer (sends to Kurento)
  // -----------------------------------------

  const msConsumer = await msTransport.consume({
    producerId: global.mediasoup.webrtc.videoProducer.id,
    rtpCapabilities: msRouter.rtpCapabilities,
    paused: false
  });
  global.mediasoup.rtp.sendConsumer = msConsumer;

  console.log(
    "mediasoup RTP consumer created, kind: %s, type: %s, paused: %s",
    msConsumer.kind,
    msConsumer.type,
    msConsumer.paused
  );

  // Kurento RtpEndpoint (receives from mediasoup)
  // ---------------------------------------------

  const msPayloadType = getMsPayloadType("video");

  const msListenIp = msTransport.tuple.localIp;
  const msListenPort = msTransport.tuple.localPort;
  const msListenPortRtcp = msTransport.rtcpTuple.localPort;

  const msSsrc = msConsumer.rtpParameters.encodings[0].ssrc;
  const msCname = msConsumer.rtpParameters.rtcp.cname;

  // SDP Offer for Kurento RtpEndpoint
  // prettier-ignore
  const kmsSdpOffer =
    "v=0\r\n" +
    `o=- 0 0 IN IP4 ${msListenIp}\r\n` +
    "s=-\r\n" +
    `c=IN IP4 ${msListenIp}\r\n` +
    "t=0 0\r\n" +
    `m=video ${msListenPort} RTP/AVP ${msPayloadType}\r\n` +
    `a=rtcp:${msListenPortRtcp}\r\n` +
    "a=sendonly\r\n" +
    `a=rtpmap:${msPayloadType} VP8/90000\r\n` +
    `a=ssrc:${msSsrc} cname:${msCname}\r\n` +
    "";

  const kmsPipeline = global.kurento.pipeline;
  const kmsEndpoint = await kmsPipeline.create("RtpEndpoint");
  global.kurento.rtp.recvEndpoint = kmsEndpoint;

  console.log("SDP Offer from App to Kurento RTP RECV: %s\n", kmsSdpOffer);
  const kmsSdpAnswer = await kmsEndpoint.processOffer(kmsSdpOffer);
  console.log("SDP Answer from Kurento RTP RECV to App:\n%s", kmsSdpAnswer);

  // WARNING - This demo assumes several things from the SDP Answer:
  // - That Kurento accepts the media encoding(s)
  // - That Kurento listens RTCP on RTP port + 1 (if RTCP-MUX not requested)
  // A real application would need to parse this SDP Answer and adapt to the
  // parameters given in it, in the standard fashion of SDP Offer/Answer Model.

  const kmsSdpAnswerObj = SdpTransform.parse(kmsSdpAnswer);

  // Build an PlainRtpParameters from the Kurento SDP Answer
  // This gives us the Kurento RTP/RTCP listening port(s)

  const plainRtpParameters = MediasoupRtpUtils.extractPlainRtpParameters({
    sdpObject: kmsSdpAnswerObj,
    kind: "video"
  });

  console.log(
    "Kurento RTP video listening: %s:%d",
    plainRtpParameters.ip,
    plainRtpParameters.port
  );

  await msTransport.connect({
    ip: plainRtpParameters.ip,
    port: plainRtpParameters.port,
    rtcpPort: plainRtpParameters.port + 1
  });

  console.log(
    "mediasoup RTP transport connected: %s:%d <--> %s:%d (%s)",
    msTransport.tuple.localIp,
    msTransport.tuple.localPort,
    msTransport.tuple.remoteIp,
    msTransport.tuple.remotePort,
    msTransport.tuple.protocol
  );

  console.log(
    "mediasoup RTCP transport connected: %s:%d <--> %s:%d (%s)",
    msTransport.rtcpTuple.localIp,
    msTransport.rtcpTuple.localPort,
    msTransport.rtcpTuple.remoteIp,
    msTransport.rtcpTuple.remotePort,
    msTransport.rtcpTuple.protocol
  );
}

// ----

async function startKurentoRtpProducer() {
  // mediasoup RTP transport (receives from Kurento)
  // ----------------------------------------------

  // There is no need to `connect()` this transport.
  // With COMEDIA enabled, mediasoup waits until Kurento starts sending data,
  // to infer Kurento's outbound port.

  const msRouter = global.mediasoup.router;
  const msTransport = await msRouter.createPlainRtpTransport({
    comedia: true,
    ...CONFIG.mediasoup.plainRtpTransport
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

  // Kurento RtpEndpoint (sends to mediasoup)
  // ----------------------------------------

  const msPayloadType = getMsPayloadType("video");

  const msListenIp = msTransport.tuple.localIp;
  const msListenPort = msTransport.tuple.localPort;
  const msListenPortRtcp = msTransport.rtcpTuple.localPort;

  // SDP Offer for Kurento RtpEndpoint
  // prettier-ignore
  const kmsSdpOffer =
    "v=0\r\n" +
    `o=- 0 0 IN IP4 ${msListenIp}\r\n` +
    "s=-\r\n" +
    `c=IN IP4 ${msListenIp}\r\n` +
    "t=0 0\r\n" +
    `m=video ${msListenPort} RTP/AVP ${msPayloadType}\r\n` +
    `a=rtcp:${msListenPortRtcp}\r\n` +
    "a=recvonly\r\n" +
    `a=rtpmap:${msPayloadType} VP8/90000\r\n` +
    "";

  const kmsPipeline = global.kurento.pipeline;
  const kmsEndpoint = await kmsPipeline.create("RtpEndpoint");
  global.kurento.rtp.sendEndpoint = kmsEndpoint;

  console.log("SDP Offer from App to Kurento RTP SEND: %s\n", kmsSdpOffer);
  const kmsSdpAnswer = await kmsEndpoint.processOffer(kmsSdpOffer);
  console.log("SDP Answer from Kurento RTP SEND to App:\n%s", kmsSdpAnswer);

  const kmsSdpAnswerObj = SdpTransform.parse(kmsSdpAnswer);

  // Build an RtpSendParameters from the Kurento SDP Answer
  // This gives us the Kurento RTP stream's SSRC, payload type, etc.

  const kmsRtpCapabilities = MediasoupSdpUtils.extractRtpCapabilities({
    sdpObject: kmsSdpAnswerObj
  });
  console.log(
    "kmsRtpCapabilities:\n%s",
    JSON.stringify(kmsRtpCapabilities, null, 2)
  );

  const msExtendedRtpCapabilities = MediasoupOrtc.getExtendedRtpCapabilities(
    kmsRtpCapabilities,
    global.mediasoup.router.rtpCapabilities
  );
  console.log(
    "msExtendedRtpCapabilities:\n%s",
    JSON.stringify(msExtendedRtpCapabilities, null, 2)
  );

  const kmsRtpSendParameters = MediasoupOrtc.getSendingRtpParameters(
    "video",
    msExtendedRtpCapabilities
  );
  kmsRtpSendParameters.encodings = MediasoupRtpUtils.getRtpEncodings({
    sdpObject: kmsSdpAnswerObj,
    kind: "video"
  });
  console.log(
    "kmsRtpSendParameters:\n%s",
    JSON.stringify(kmsRtpSendParameters, null, 2)
  );

  // mediasoup RTP producer (receives from Kurento)
  // ----------------------------------------------

  const msProducer = await msTransport.produce({
    kind: "video",
    rtpParameters: kmsRtpSendParameters,
    paused: false
  });
  global.mediasoup.rtp.recvProducer = msProducer;

  console.log(
    "mediasoup RTP producer created, kind: %s, type: %s, paused: %s",
    msProducer.kind,
    msProducer.type,
    msProducer.paused
  );
}

// ----

async function startKurentoFilter() {
  const kmsPipeline = global.kurento.pipeline;
  const filter = await kmsPipeline.create("GStreamerFilter", {
    command: "videobalance saturation=0.0"
  });
  global.kurento.filter = filter;

  //# [KURENTO PIPELINE]
  const recvEndpoint = global.kurento.rtp.recvEndpoint;
  const sendEndpoint = global.kurento.rtp.sendEndpoint;

  await recvEndpoint.connect(filter);
  await filter.connect(sendEndpoint);
}

// ----------------------------------------------------------------------------

async function handleDebug() {
  console.log(
    "[DEBUG] mediasoup RTP SEND transport stats (sent to Kurento):\n",
    await global.mediasoup.rtp.sendTransport.getStats()
  );
  console.log(
    "[DEBUG] mediasoup RTP SEND consumer stats (sent to Kurento):\n",
    await global.mediasoup.rtp.sendConsumer.getStats()
  );
  console.log(
    "[DEBUG] mediasoup RTP RECV transport stats (received from Kurento):\n",
    await global.mediasoup.rtp.recvTransport.getStats()
  );
  console.log(
    "[DEBUG] mediasoup RTP RECV producer stats (received from Kurento):\n",
    await global.mediasoup.rtp.recvProducer.getStats()
  );
}

// ----------------------------------------------------------------------------
