const CONFIG = require("./config");
const Express = require("express");
const Fs = require("fs");
const Https = require("https");
const Mediasoup = require("mediasoup");
const MediasoupOrtc = require("mediasoup-client/lib/ortc");
const MediasoupRtpUtils = require("mediasoup-client/lib/handlers/sdp/plainRtpUtils");
const MediasoupSdpUtils = require("mediasoup-client/lib/handlers/sdp/commonUtils");
const SdpTransform = require("sdp-transform");
const SocketServer = require("socket.io");

// const Util = require("util");
// const KurentoClient = Util.promisify(require("kurento-client"));
const KurentoClient = require("kurento-client");

// Global state
// A real application would store this in user session(s)
const global = {
  server: {
    express: null,
    https: null,
    socketServer: null,
    socket: null
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
      transport: null,
      producer: null, // To receive
      consumer: null // To send
    }
  },

  kurento: {
    client: null,
    pipeline: null,
    gstFilter: null,
    rtpEndpoint: null
  }
};

// ----------------------------------------------------------------------------

// Express application
// ===================
{
  const express = Express();
  global.server.express = express;

  express.use(Express.json());
  express.use(Express.static(__dirname));
  express.use((err, req, res, next) => {
    if (err) {
      console.warn("Express app error:", err.message);
      err.status = err.status || (err.name === "TypeError" ? 400 : 500);
      res.statusMessage = err.message;
      res.status(err.status).send(String(err));
    } else {
      next();
    }
  });
}

// ----------------------------------------------------------------------------

// HTTPS server
// ============
{
  const https = Https.createServer(
    {
      cert: Fs.readFileSync(CONFIG.https.cert),
      key: Fs.readFileSync(CONFIG.https.certKey)
    },
    global.server.express
  );
  global.server.https = https;

  https.on("error", err => {
    console.error("HTTPS error:", err.message);
  });
  https.on("tlsClientError", err => {
    console.error("TLS error:", err.message);
  });
  https.listen(CONFIG.https.port, CONFIG.https.ip, () => {
    console.log(
      "Server is running:",
      `https://${CONFIG.https.ip}:${CONFIG.https.port}`
    );
  });
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
      "WebSocket server connected with %s:%s",
      socket.request.connection.remoteAddress,
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
  });
}

// ----------------------------------------------------------------------------

// WebSocket handlers
// ==================

async function handleRequest(request, callback) {
  let responseData = null;

  switch (request.type) {
    case "CLIENT_START_MEDIASOUP":
      responseData = await handleStartMediasoup();
      break;
    case "CLIENT_START_RECV_TRANSPORT":
      responseData = await handleStartRecvTransport();
      break;
    case "CLIENT_CONNECT_KURENTO":
      await handleConnectKurento();
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

  const transport = await router.createWebRtcTransport(
    CONFIG.mediasoup.webRtcTransport
  );
  global.mediasoup.webrtc.recvTransport = transport;

  console.log("mediasoup WebRTC RECV transport created");

  // Uncomment for debug
  // console.log("webrtcTransportOptions:\n%s", JSON.stringify(webrtcTransportOptions, null, 2));

  const webrtcTransportOptions = {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    sctpParameters: transport.sctpParameters
  };

  return webrtcTransportOptions;
}

// ----------------------------------------------------------------------------

// Creates a mediasoup WebRTC SEND transport

async function handleStartSendTransport() {
  const router = global.mediasoup.router;

  const transport = await router.createWebRtcTransport(
    CONFIG.mediasoup.webRtcTransport
  );
  global.mediasoup.webrtc.sendTransport = transport;

  console.log("mediasoup WebRTC SEND transport created");

  // Uncomment for debug
  // console.log("webrtcTransportOptions:\n%s", JSON.stringify(webrtcTransportOptions, null, 2));

  const webrtcTransportOptions = {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    sctpParameters: transport.sctpParameters
  };

  return webrtcTransportOptions;
}

// ----------------------------------------------------------------------------

// Calls WebRtcTransport.connect() whenever the browser client part is ready

async function handleConnectRecvTransport(dtlsParameters) {
  const transport = global.mediasoup.webrtc.recvTransport;

  await transport.connect({ dtlsParameters });

  console.log("mediasoup WebRTC RECV transport connected");
}

// ----------------------------------------------------------------------------

// Calls WebRtcTransport.connect() whenever the browser client part is ready

async function handleConnectSendTransport(dtlsParameters) {
  const transport = global.mediasoup.webrtc.sendTransport;

  await transport.connect({ dtlsParameters });

  console.log("mediasoup WebRTC SEND transport connected");
}

// ----------------------------------------------------------------------------

// Calls WebrtcTransport.produce() to start receiving media from the browser

async function handleStartRecvProducer(produceParameters, callback) {
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

// Calls WebrtcTransport.consume() to start sending media to the browser

async function handleStartSendConsumer(rtpCapabilities) {
  const transport = global.mediasoup.webrtc.sendTransport;

  const consumer = await transport.consume({

    //[SELECT PRODUCER]
    // producerId: global.mediasoup.webrtc.videoProducer.id,
    producerId: global.mediasoup.rtp.producer.id,

    rtpCapabilities: rtpCapabilities,
    paused: false
  });

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

async function handleConnectKurento() {
  const kmsPipeline = await startKurento();
  await startKurentoRtp(kmsPipeline);

  // await startRtpFromKurento();
  // await startRtpToKurento();
}

async function startKurento() {
  const kurentoUrl = `ws://${CONFIG.https.ip}:${CONFIG.kurento.port}${CONFIG.kurento.wsPath}`;
  console.log("Connect with Kurento Media Server:", kurentoUrl);

  const client = await new KurentoClient(kurentoUrl);
  global.kurento.client = client;
  console.log("Kurento client connected");

  const pipeline = await client.create("MediaPipeline");
  global.kurento.pipeline = pipeline;
  console.log("Kurento pipeline created");

  return pipeline;
}

// ----

async function startKurentoRtp(kmsPipeline) {
  // RTP transport
  // -------------

  const router = global.mediasoup.router;

  const transport = await router.createPlainRtpTransport(
    CONFIG.mediasoup.plainRtpTransport
  );
  global.mediasoup.rtp.transport = transport;

  console.log(
    "mediasoup RTP transport created: %s:%d (%s)",
    transport.tuple.localIp,
    transport.tuple.localPort,
    transport.tuple.protocol
  );

  const msListenIp = transport.tuple.localIp;
  const msListenPort = transport.tuple.localPort;

  //[RTCP-MUX]
  // console.log(
  //   "mediasoup RTCP transport created: %s:%d (%s)",
  //   transport.rtcpTuple.localIp,
  //   transport.rtcpTuple.localPort,
  //   transport.rtcpTuple.protocol
  // );
  // const msListenPortRtcp = transport.rtcpTuple.localPort;

  // RTP consumer (sends to Kurento)
  // -------------------------------

  const consumer = await transport.consume({
    producerId: global.mediasoup.webrtc.videoProducer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: false
  });
  global.mediasoup.rtp.consumer = consumer;

  console.log(
    "mediasoup RTP consumer created, kind: %s, type: %s, paused: %s",
    consumer.kind,
    consumer.type,
    consumer.paused
  );

  const msSsrc = consumer.rtpParameters.encodings[0].ssrc;
  const msCname = consumer.rtpParameters.rtcp.cname;

  // RTP producer (receives from Kurento)
  // ------------------------------------

  // Get mediasoup PayloadType for video
  let msPayloadType = 96;
  const codec = CONFIG.mediasoup.router.mediaCodecs.find(
    c => c.kind === "video"
  );
  if (codec) {
    msPayloadType = codec.preferredPayloadType;
  }

  // SDP Offer for Kurento RtpEndpoint
  // prettier-ignore
  const kmsSdpOffer =
    "v=0\r\n" +
    `o=- 0 0 IN IP4 ${msListenIp}\r\n` +
    "s=-\r\n" +
    `c=IN IP4 ${msListenIp}\r\n` +
    "t=0 0\r\n" +
    `m=video ${msListenPort} RTP/AVP ${msPayloadType}\r\n` +

    //[RTCP-MUX]
    "a=rtcp-mux\r\n" +
    // `a=rtcp:${msListenPortRtcp}\r\n` +

    "a=sendrecv\r\n" +
    `a=rtpmap:${msPayloadType} VP8/90000\r\n` +
    `a=ssrc:${msSsrc} cname:${msCname}\r\n` +
    "";

  console.log("Fake SDP Offer from App to KMS:\n%s", kmsSdpOffer);

  // Generate the RtpParameters equivalent to the Kurento SDP Offer
  const kmsSdpOfferObj = SdpTransform.parse(kmsSdpOffer);
  console.log("kmsSdpOfferObj:\n%s", JSON.stringify(kmsSdpOfferObj, null, 2));
  const kmsRtpCapabilities = MediasoupSdpUtils.extractRtpCapabilities({
    sdpObject: kmsSdpOfferObj
  });
  console.log("kmsRtpCapabilities:\n%s", JSON.stringify(kmsRtpCapabilities, null, 2));
  const msExtendedRtpCapabilities = MediasoupOrtc.getExtendedRtpCapabilities(
    kmsRtpCapabilities,
    global.mediasoup.router.rtpCapabilities
  );
  console.log("msExtendedRtpCapabilities:\n%s", JSON.stringify(msExtendedRtpCapabilities, null, 2));
  const kmsRtpParameters = MediasoupOrtc.getSendingRtpParameters(
    "video",
    msExtendedRtpCapabilities
  );
  kmsRtpParameters.encodings = MediasoupRtpUtils.getRtpEncodings({
    sdpObject: kmsSdpOfferObj,
    kind: "video"
  });
  console.log("kmsRtpParameters:\n%s", JSON.stringify(kmsRtpParameters, null, 2));

  // Create the mediasoup producer
  const producer = await transport.produce({
    kind: "video",
    rtpParameters: kmsRtpParameters,
    paused: false
  });
  global.mediasoup.rtp.producer = producer;

  console.log(
    "mediasoup RTP producer created, kind: %s, type: %s, paused: %s",
    producer.kind,
    producer.type,
    producer.paused
  );

  // Kurento pipeline
  // ----------------

  const gstFilter = await kmsPipeline.create("GStreamerFilter", {
    command: "videobalance saturation=0.0"
  });
  global.kurento.gstFilter = gstFilter;

  const rtpEndpoint = await kmsPipeline.create("RtpEndpoint");
  global.kurento.rtpEndpoint = rtpEndpoint;

  //[KURENTO PIPELINE]
  // await rtpEndpoint.connect(gstFilter);
  // await gstFilter.connect(rtpEndpoint);
  //
  await rtpEndpoint.connect(rtpEndpoint, "VIDEO");

  // console.log("RTP SDP Offer from app: %s\n", kmsSdpOffer);
  const kmsSdpAnswer = await rtpEndpoint.processOffer(kmsSdpOffer);
  console.log("SDP Answer from KMS to App:\n%s", kmsSdpAnswer);

  const kmsSdpAnswerObj = SdpTransform.parse(kmsSdpAnswer);
  const plainRtpParameters = MediasoupRtpUtils.extractPlainRtpParameters({
    sdpObject: kmsSdpAnswerObj,
    kind: "video"
  });

  console.log(
    "Kurento RTP video listening: %s:%d",
    plainRtpParameters.ip,
    plainRtpParameters.port
  );

  await transport.connect({
    ip: plainRtpParameters.ip,
    port: plainRtpParameters.port,

    //[RTCP-MUX]
    // If rtcp-mux is enabled, this should not be defined (same port as RTP)
    // rtcpPort: plainRtpParameters.port + 1
  });

  console.log(
    "mediasoup RTP transport connected: %s:%d -> %s:%d (%s)",
    transport.tuple.localIp,
    transport.tuple.localPort,
    transport.tuple.remoteIp,
    transport.tuple.remotePort,
    transport.tuple.protocol
  );

  //[RTCP-MUX]
  // console.log(
  //   "mediasoup RTCP transport connected: %s:%d -> %s:%d (%s)",
  //   transport.rtcpTuple.localIp,
  //   transport.rtcpTuple.localPort,
  //   transport.rtcpTuple.remoteIp,
  //   transport.rtcpTuple.remotePort,
  //   transport.rtcpTuple.protocol
  // );
}

// ----------------------------------------------------------------------------
