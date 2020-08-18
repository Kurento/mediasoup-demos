"use strict";

const CONFIG = require("./config");
const MediasoupClient = require("mediasoup-client");
const SocketClient = require("socket.io-client");
const SocketPromise = require("socket.io-promise").default;

// ----------------------------------------------------------------------------

// Global state
// ============

const global = {
  server: {
    socket: null,
  },

  mediasoup: {
    device: null,

    // WebRTC connection with mediasoup
    webrtc: {
      sendTransport: null,
      audioProducer: null,
      videoProducer: null,

      recvTransport: null,
      audioConsumer: null,
      videoConsumer: null,
    },
  },
};

// ----------------------------------------------------------------------------

// HTML UI elements
// ================

const ui = {
  settings: document.getElementById("uiSettings"),
  console: document.getElementById("uiConsole"),

  // <button>
  startWebRTC: document.getElementById("uiStartWebRTC"),
  connectKurento: document.getElementById("uiConnectKurento"),
  debug: document.getElementById("uiDebug"),

  // <video>
  localVideo: document.getElementById("uiLocalVideo"),
  remoteVideo: document.getElementById("uiRemoteVideo"),
};

ui.startWebRTC.onclick = startWebRTC;
ui.connectKurento.onclick = connectKurento;
ui.debug.onclick = () => {
  if (global.server.socket) {
    global.server.socket.emit("DEBUG");
  }
};

// ----------------------------------------------------------------------------

window.addEventListener("load", function () {
  console.log("Page loaded, connect WebSocket");
  connectSocket();

  if ("adapter" in window) {
    console.log(
      // eslint-disable-next-line no-undef
      `webrtc-adapter loaded, browser: '${adapter.browserDetails.browser}', version: '${adapter.browserDetails.version}'`
    );
  } else {
    console.warn("webrtc-adapter is not loaded! an install or config issue?");
  }
});

window.addEventListener("beforeunload", function () {
  console.log("Page unloading, close WebSocket");
  global.server.socket.close();
});

// ----

function connectSocket() {
  const serverUrl = `https://${window.location.host}`;

  console.log("Connect with Application Server:", serverUrl);

  const socket = SocketClient(serverUrl, {
    path: CONFIG.https.wsPath,
    transports: ["websocket"],
  });
  global.server.socket = socket;

  socket.on("connect", () => {
    console.log("WebSocket connected");
  });

  socket.on("error", (err) => {
    console.error("WebSocket error:", err);
  });

  socket.on("LOG", (log) => {
    ui.console.value += log + "\n";
    ui.console.scrollTop = ui.console.scrollHeight;
  });

  socket.on("WEBRTC_RECV_PRODUCER_READY", (kind) => {
    console.log(`Server producer is ready, kind: ${kind}`);

    // Update UI
    ui.settings.disabled = true;
    ui.startWebRTC.disabled = true;
    ui.connectKurento.disabled = false;
  });
}

// ----------------------------------------------------------------------------

async function startWebRTC() {
  console.log("Start WebRTC transmission from browser to mediasoup");

  await startMediasoup();
  await startWebrtcSend();
}

// ----

async function startMediasoup() {
  const socket = global.server.socket;

  const socketRequest = SocketPromise(socket);
  const response = await socketRequest({ type: "START_MEDIASOUP" });
  const routerRtpCapabilities = response.data;

  console.log("[server] mediasoup router created");

  let device = null;
  try {
    device = new MediasoupClient.Device();
  } catch (err) {
    console.error(err);
    return;
  }
  global.mediasoup.device = device;

  try {
    await device.load({ routerRtpCapabilities });
  } catch (err) {
    console.error(err);
    return;
  }

  console.log(
    "mediasoup device created, handlerName: %s, use audio: %s, use video: %s",
    device.handlerName,
    device.canProduce("audio"),
    device.canProduce("video")
  );

  // Uncomment for debug
  // console.log("rtpCapabilities:\n%O", device.rtpCapabilities);
}

// ----

async function startWebrtcSend() {
  const device = global.mediasoup.device;
  const socket = global.server.socket;

  // mediasoup WebRTC transport
  // --------------------------

  const socketRequest = SocketPromise(socket);
  const response = await socketRequest({ type: "WEBRTC_RECV_START" });
  const webrtcTransportOptions = response.data;

  console.log("[server] WebRTC RECV transport created");

  let transport;
  try {
    transport = device.createSendTransport(webrtcTransportOptions);
  } catch (err) {
    console.error(err);
    return;
  }
  global.mediasoup.webrtc.sendTransport = transport;

  console.log("[client] WebRTC SEND transport created");

  // "connect" is emitted upon the first call to transport.produce()
  transport.on("connect", ({ dtlsParameters }, callback, _errback) => {
    // Signal local DTLS parameters to the server side transport
    socket.emit("WEBRTC_RECV_CONNECT", dtlsParameters);
    callback();
  });

  // "produce" is emitted upon each call to transport.produce()
  transport.on("produce", (produceParameters, callback, _errback) => {
    socket.emit("WEBRTC_RECV_PRODUCE", produceParameters, (producerId) => {
      console.log("[server] WebRTC RECV producer created");
      callback({ producerId });
    });
  });

  // mediasoup WebRTC producer
  // -------------------------

  // Get user media as required

  let useAudio = false;
  let useVideo = true;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: useAudio,
      video: useVideo,
    });
  } catch (err) {
    console.error(err);
    return;
  }

  ui.localVideo.srcObject = stream;

  // Start mediasoup-client's WebRTC producer(s)

  if (useAudio) {
    const audioTrack = stream.getAudioTracks()[0];
    const audioProducer = await transport.produce({ track: audioTrack });
    global.mediasoup.webrtc.audioProducer = audioProducer;
  }

  if (useVideo) {
    const videoTrack = stream.getVideoTracks()[0];
    const videoProducer = await transport.produce({
      track: videoTrack,
      ...CONFIG.mediasoup.client.videoProducer,
    });
    global.mediasoup.webrtc.videoProducer = videoProducer;
  }
}

// ----------------------------------------------------------------------------

async function connectKurento() {
  const socket = global.server.socket;

  // Start an (S)RTP transport as required

  const uiTransport = document.querySelector(
    "input[name='uiTransport']:checked"
  ).value;
  let enableSrtp = false;
  if (uiTransport.indexOf("srtp") !== -1) {
    enableSrtp = true;
  }

  const socketRequest = SocketPromise(socket);
  await socketRequest({ type: "START_KURENTO", enableSrtp: enableSrtp });
  await startWebrtcRecv();

  // Update UI
  ui.connectKurento.disabled = true;
  ui.debug.disabled = false;
}

// ----

async function startWebrtcRecv() {
  const socket = global.server.socket;
  const device = global.mediasoup.device;

  // mediasoup WebRTC transport
  // --------------------------

  const socketRequest = SocketPromise(socket);
  let response = await socketRequest({ type: "WEBRTC_SEND_START" });
  const webrtcTransportOptions = response.data;

  console.log("[server] WebRTC SEND transport created");

  let transport;
  try {
    transport = device.createRecvTransport(webrtcTransportOptions);
  } catch (err) {
    console.error(err);
    return;
  }
  global.mediasoup.webrtc.recvTransport = transport;

  console.log("[client] WebRTC RECV transport created");

  // "connect" is emitted upon the first call to transport.consume()
  transport.on("connect", ({ dtlsParameters }, callback, _errback) => {
    // Signal local DTLS parameters to the server side transport
    socket.emit("WEBRTC_SEND_CONNECT", dtlsParameters);
    callback();
  });

  // mediasoup WebRTC consumer
  // -------------------------

  response = await socketRequest({
    type: "WEBRTC_SEND_CONSUME",
    rtpCapabilities: device.rtpCapabilities,
  });
  const webrtcConsumerOptions = response.data;

  console.log("[server] WebRTC SEND consumer created");

  let useAudio = false;
  let useVideo = true;

  // Start mediasoup-client's WebRTC consumer(s)

  const stream = new MediaStream();
  ui.remoteVideo.srcObject = stream;

  if (useAudio) {
    // ...
  }

  if (useVideo) {
    const consumer = await transport.consume(webrtcConsumerOptions);
    global.mediasoup.webrtc.videoConsumer = consumer;
    stream.addTrack(consumer.track);

    console.log("[client] WebRTC RECV consumer created");
  }
}

// ----------------------------------------------------------------------------
