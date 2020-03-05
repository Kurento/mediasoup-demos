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
      global.server.socket.emit("LOG", Util.format(...args));
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
    console.log(
      `Web server is listening on https://localhost:${CONFIG.https.port}`
    );
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
      await handleStartKurento();
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

  // At this point, the computed "router.rtpCapabilities" includes the
  // router codecs enhanced with retransmission and RTCP capabilities,
  // and the list of RTP header extensions supported by mediasoup.

  console.log("mediasoup router created");

  // Uncomment for debug
  // console.log("router.rtpCapabilities: %s", JSON.stringify(router.rtpCapabilities, null, 2));

  return router.rtpCapabilities;
}

// ----------------------------------------------------------------------------

// Creates a mediasoup WebRTC RECV transport

async function handleWebrtcRecvStart() {
  const router = global.mediasoup.router;

  const transport = await router.createWebRtcTransport(
    CONFIG.mediasoup.webrtcTransport
  );
  global.mediasoup.webrtc.recvTransport = transport;

  console.log("mediasoup WebRTC RECV transport created");

  const webrtcTransportOptions = {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    sctpParameters: transport.sctpParameters
  };

  // Uncomment for debug
  // console.log("webrtcTransportOptions: %s", JSON.stringify(webrtcTransportOptions, null, 2));

  return webrtcTransportOptions;
}

// ----------------------------------------------------------------------------

// Creates a mediasoup WebRTC SEND transport

async function handleWebrtcSendStart() {
  const router = global.mediasoup.router;

  const transport = await router.createWebRtcTransport(
    CONFIG.mediasoup.webrtcTransport
  );
  global.mediasoup.webrtc.sendTransport = transport;

  console.log("mediasoup WebRTC SEND transport created");

  const webrtcTransportOptions = {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    sctpParameters: transport.sctpParameters
  };

  // Uncomment for debug
  // console.log("webrtcTransportOptions: %s", JSON.stringify(webrtcTransportOptions, null, 2));

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

  // Uncomment for debug
  // console.log("producer.rtpParameters: %s", JSON.stringify(producer.rtpParameters, null, 2));

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
  // console.log("consumer.rtpParameters: %s", JSON.stringify(consumer.rtpParameters, null, 2));

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

// Helper function:
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

// Helper function:
// Get RtcpParameters (https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtcpParameters)
// from an SDP object obtained from `SdpTransform.parse()`.
// We need this because MediasoupRtpUtils has useful functions like
// `getRtpEncodings()`, but it lacks something like `getRtcpParameters()`.
function getRtcpParameters(sdpObject, kind) {
  const mediaObject = (sdpObject.media || []).find(m => m.type === kind);
  if (!mediaObject) {
    throw new Error(`m=${kind} section not found`);
  }

  // Get CNAME
  const ssrcCname = (mediaObject.ssrcs || []).find(
    s => s.attribute && s.attribute === "cname"
  );
  const cname = ssrcCname && ssrcCname.value ? ssrcCname.value : null;

  // Get RTCP Reduced Size ("a=rtcp-rsize")
  const reducedSize = "rtcpRsize" in mediaObject;

  return { cname: cname, reducedSize: reducedSize };
}

// ----

async function startKurentoRtpConsumer() {
  const msRouter = global.mediasoup.router;
  const kmsPipeline = global.kurento.pipeline;

  // mediasoup RTP transport
  // -----------------------

  const msTransport = await msRouter.createPlainRtpTransport({
    // COMEDIA mode must be disabled here: the corresponding Kurento RtpEndpoint
    // is going to act as receive-only peer, thus it will never send RTP data
    // to mediasoup, which is a mandatory condition to use COMEDIA
    comedia: false,

    // Kurento RtpEndpoint doesn't support RTP/RTCP multiplexing ("a=rtcp-mux" in SDP)
    rtcpMux: false,

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

  // mediasoup RTP consumer (Send media to Kurento)
  // ----------------------------------------------

  const msPayloadType = getMsPayloadType("video");

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
          { type: "nack", parameter: "pli" }
        ]
      }
    ]
  };

  const msConsumer = await msTransport.consume({
    producerId: global.mediasoup.webrtc.videoProducer.id,
    rtpCapabilities: kmsRtpCapabilities,
    paused: false
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

  // Kurento RtpEndpoint (Receive media from mediasoup)
  // --------------------------------------------------

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
    `m=video ${msListenPort} RTP/AVPF ${msPayloadType}\r\n` +
    `a=rtcp:${msListenPortRtcp}\r\n` +
    "a=sendonly\r\n" +
    `a=rtpmap:${msPayloadType} VP8/90000\r\n` +
    `a=rtcp-fb:${msPayloadType} goog-remb\r\n` +
    `a=rtcp-fb:${msPayloadType} ccm fir\r\n` +
    `a=rtcp-fb:${msPayloadType} nack\r\n` +
    `a=rtcp-fb:${msPayloadType} nack pli\r\n` +
    `a=ssrc:${msSsrc} cname:${msCname}\r\n` +
    "";

  const kmsEndpoint = await kmsPipeline.create("RtpEndpoint");
  global.kurento.rtp.recvEndpoint = kmsEndpoint;

  console.log("SDP Offer from App to Kurento RTP RECV:\n%s", kmsSdpOffer);
  const kmsSdpAnswer = await kmsEndpoint.processOffer(kmsSdpOffer);
  console.log("SDP Answer from Kurento RTP RECV to App:\n%s", kmsSdpAnswer);

  // NOTE: A real application would need to parse this SDP Answer and adapt to
  // the parameters given in it, following the SDP Offer/Answer Model.
  // For example, if Kurento didn't support NACK PLI, then it would reply
  // without that attribute in the SDP Answer, and this app should notice it and
  // reconfigure accordingly.
  // Here, we'll just assume that the SDP Answer from Kurento is accepting all
  // of our medias, formats, and options.

  const kmsSdpAnswerObj = SdpTransform.parse(kmsSdpAnswer);
  console.log("kmsSdpAnswerObj: %s", JSON.stringify(kmsSdpAnswerObj, null, 2));

  // Get the Kurento RTP/RTCP listening port(s) from the Kurento SDP Answer

  const mediaObj = (kmsSdpAnswerObj.media || []).find(m => m.type === "video");
  if (!mediaObj) {
    throw new Error("m=video section not found");
  }

  const connectionObj = mediaObj.connection || kmsSdpAnswerObj.connection;
  let kmsIp = connectionObj.ip;
  const rtpPort = mediaObj.port;
  let rtcpPort = rtpPort + 1;
  if ("rtcp" in mediaObj) {
    // If "a=rtcp:<Port>" is found in the SDP Answer
    rtcpPort = mediaObj.rtcp.port;
  }

  console.log(`Kurento video RTP listening on ${kmsIp}:${rtpPort}`);
  console.log(`Kurento video RTCP listening on ${kmsIp}:${rtcpPort}`);

  // Check if Kurento IP address is actually a localhost address, and in that
  // case use "127.0.0.1" instead. This is needed to ensure that the source IP
  // of RTP packets matches with the IP that is given here to connect().
  // Uses `os.networkInterfaces()` (https://nodejs.org/api/os.html#os_os_networkinterfaces)
  // to search for the Kurento IP address in each of the local interfaces.
  if (
    Object.values(require("os").networkInterfaces()).some(iface =>
      iface.some(netaddr => netaddr.address === kmsIp)
    )
  ) {
    kmsIp = "127.0.0.1";
  }

  await msTransport.connect({
    ip: kmsIp,
    port: rtpPort,
    rtcpPort: rtcpPort
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

// ----

async function startKurentoRtpProducer() {
  const msRouter = global.mediasoup.router;
  const kmsPipeline = global.kurento.pipeline;

  // mediasoup RTP transport
  // -----------------------

  const msTransport = await msRouter.createPlainRtpTransport({
    // There is no need to `connect()` this transport: with COMEDIA enabled,
    // mediasoup waits until Kurento starts sending RTP, to detect Kurento's
    // outbound RTP and RTCP ports.
    comedia: true,

    // Kurento RtpEndpoint doesn't support RTP/RTCP multiplexing ("a=rtcp-mux" in SDP)
    rtcpMux: false,

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

  // Kurento RtpEndpoint (Send media to mediasoup)
  // ---------------------------------------------

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
    `m=video ${msListenPort} RTP/AVPF ${msPayloadType}\r\n` +
    `a=rtcp:${msListenPortRtcp}\r\n` +
    "a=recvonly\r\n" +
    `a=rtpmap:${msPayloadType} VP8/90000\r\n` +
    `a=rtcp-fb:${msPayloadType} goog-remb\r\n` +
    `a=rtcp-fb:${msPayloadType} ccm fir\r\n` +
    `a=rtcp-fb:${msPayloadType} nack\r\n` +
    `a=rtcp-fb:${msPayloadType} nack pli\r\n` +
    "";

  const kmsEndpoint = await kmsPipeline.create("RtpEndpoint");
  global.kurento.rtp.sendEndpoint = kmsEndpoint;
  await kmsEndpoint.setMaxVideoSendBandwidth(2000); // Send max 2 mbps

  console.log("SDP Offer from App to Kurento RTP SEND:\n%s", kmsSdpOffer);
  const kmsSdpAnswer = await kmsEndpoint.processOffer(kmsSdpOffer);
  console.log("SDP Answer from Kurento RTP SEND to App:\n%s", kmsSdpAnswer);

  // NOTE: A real application would need to parse this SDP Answer and adapt to
  // the parameters given in it, following the SDP Offer/Answer Model.
  // For example, if Kurento didn't support NACK PLI, then it would reply
  // without that attribute in the SDP Answer, and this app should notice it and
  // reconfigure accordingly.
  // Here, we'll just assume that the SDP Answer from Kurento is accepting all
  // of our medias, formats, and options.

  const kmsSdpAnswerObj = SdpTransform.parse(kmsSdpAnswer);
  console.log("kmsSdpAnswerObj: %s", JSON.stringify(kmsSdpAnswerObj, null, 2));

  // Build an RtpSendParameters from the Kurento SDP Answer,
  // this gives us the Kurento RTP stream's SSRC, payload type, etc.

  const kmsRtpCapabilities = MediasoupSdpUtils.extractRtpCapabilities({
    sdpObject: kmsSdpAnswerObj
  });
  console.log(
    "kmsRtpCapabilities: %s",
    JSON.stringify(kmsRtpCapabilities, null, 2)
  );

  const msExtendedRtpCapabilities = MediasoupOrtc.getExtendedRtpCapabilities(
    kmsRtpCapabilities,
    global.mediasoup.router.rtpCapabilities
  );
  console.log(
    "msExtendedRtpCapabilities: %s",
    JSON.stringify(msExtendedRtpCapabilities, null, 2)
  );

  const kmsRtpSendParameters = MediasoupOrtc.getSendingRtpParameters(
    "video",
    msExtendedRtpCapabilities
  );

  // MediasoupOrtc.getSendingRtpParameters() leaves empty "mid", "encodings",
  // and "rtcp" fields
  kmsRtpSendParameters.encodings = MediasoupRtpUtils.getRtpEncodings({
    sdpObject: kmsSdpAnswerObj,
    kind: "video"
  });
  kmsRtpSendParameters.rtcp = getRtcpParameters(kmsSdpAnswerObj, "video");
  console.log(
    "kmsRtpSendParameters: %s",
    JSON.stringify(kmsRtpSendParameters, null, 2)
  );

  // mediasoup RTP producer (Receive media from Kurento)
  // ---------------------------------------------------

  const msProducer = await msTransport.produce({
    kind: "video",
    rtpParameters: kmsRtpSendParameters,
    paused: false
  });
  global.mediasoup.rtp.recvProducer = msProducer;

  console.log(
    "mediasoup RTP RECV producer created, kind: %s, type: %s, paused: %s",
    msProducer.kind,
    msProducer.type,
    msProducer.paused
  );
}

// ----

async function startKurentoFilter() {
  const kmsPipeline = global.kurento.pipeline;
  const recvEndpoint = global.kurento.rtp.recvEndpoint;
  const sendEndpoint = global.kurento.rtp.sendEndpoint;

  const filter = await kmsPipeline.create("GStreamerFilter", {
    command: "videobalance saturation=0.0"
  });
  global.kurento.filter = filter;

  await recvEndpoint.connect(filter);
  await filter.connect(sendEndpoint);
}

// ----------------------------------------------------------------------------

async function handleDebug() {
  console.log(
    "[DEBUG] mediasoup RTP SEND transport stats (Send to Kurento):\n",
    await global.mediasoup.rtp.sendTransport.getStats()
  );
  console.log(
    "[DEBUG] mediasoup RTP SEND consumer stats (Send to Kurento):\n",
    await global.mediasoup.rtp.sendConsumer.getStats()
  );
  console.log(
    "[DEBUG] mediasoup RTP RECV transport stats (Receive from Kurento):\n",
    await global.mediasoup.rtp.recvTransport.getStats()
  );
  console.log(
    "[DEBUG] mediasoup RTP RECV producer stats (Receive from Kurento):\n",
    await global.mediasoup.rtp.recvProducer.getStats()
  );
}

// ----------------------------------------------------------------------------
