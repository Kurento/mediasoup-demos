"use strict";

const CONFIG = require("./config");
const MediasoupClient = require("mediasoup-client");
const SocketClient = require("socket.io-client");
const SocketPromise = require("socket.io-promise").default;

// ----------------------------------------------------------------------------

// Application state
// =================

const global = {
  server: {
    socket: null
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
      videoConsumer: null
    }
  }
};

// ----------------------------------------------------------------------------

// HTML UI elements
// ================

const ui = {
  console: document.getElementById("uiConsole"),

  // <button>
  startWebRTC: document.getElementById("uiStartWebRTC"),
  connectKurento: document.getElementById("uiConnectKurento"),
  debug: document.getElementById("uiDebug"),

  // <video>
  localVideo: document.getElementById("uiLocalVideo"),
  remoteVideo: document.getElementById("uiRemoteVideo")
};

ui.startWebRTC.onclick = startWebRTC;
ui.connectKurento.onclick = connectKurento;
ui.debug.onclick = () => {
  if (global.server.socket) {
    global.server.socket.emit("CLIENT_DEBUG");
  }
};

// ----------------------------------------------------------------------------

window.onload = () => {
  console.log("Page load, connect WebSocket");
  connectSocket();
};

window.onbeforeunload = () => {
  console.log("Page unload, close WebSocket");
  global.server.socket.close();
};

// ----

function connectSocket() {
  const serverUrl = `https://${window.location.host}`;

  console.log("Connect with Application Server:", serverUrl);

  const socket = SocketClient(serverUrl, {
    path: CONFIG.https.wsPath,
    transports: ["websocket"]
  });
  global.server.socket = socket;

  socket.on("connect", () => {
    console.log("WebSocket connected");
  });

  socket.on("error", err => {
    console.error("WebSocket error:", err);
  });

  socket.on("SERVER_LOG", log => {
    ui.console.value += log + "\n";
    ui.console.scrollTop = ui.console.scrollHeight;
  });
}

// ----------------------------------------------------------------------------

async function startWebRTC() {
  console.log("Start WebRTC transmission from browser to mediasoup");

  const device = await startMediasoup();
  const sendTransport = await startSendTransport(device);
  await startProducer(sendTransport);
}

// ----

async function startMediasoup() {
  const socket = global.server.socket;
  const socketRequest = SocketPromise(socket);
  const response = await socketRequest({ type: "CLIENT_START_MEDIASOUP" });
  const routerRtpCapabilities = response.data;

  console.log("[server] mediasoup router created");

  let device = null;
  try {
    device = new MediasoupClient.Device();
  } catch (err) {
    if (err.name === "UnsupportedError") {
      console.error("mediasoup-client doesn't support this browser");
      return null;
    }
  }
  global.mediasoup.device = device;

  try {
    await device.load({ routerRtpCapabilities });
  } catch (err) {
    if (err.name === "InvalidStateError") {
      console.warn("mediasoup device was already loaded");
    }
  }

  console.log(
    "mediasoup device created, handlerName: %s, use audio: %s, use video: %s",
    device.handlerName,
    device.canProduce("audio"),
    device.canProduce("video")
  );

  // Uncomment for debug
  // console.log("rtpCapabilities:\n%s", JSON.stringify(device.rtpCapabilities, null, 2));

  return device;
}

// ----

async function startSendTransport(device) {
  const socket = global.server.socket;
  const socketRequest = SocketPromise(socket);
  const response = await socketRequest({ type: "CLIENT_START_RECV_TRANSPORT" });
  const webrtcTransportOptions = response.data;

  console.log("[server] WebRTC RECV transport created");

  const transport = await device.createSendTransport(webrtcTransportOptions);
  global.mediasoup.webrtc.sendTransport = transport;

  console.log("[client] WebRTC SEND transport created");

  transport.on("connect", ({ dtlsParameters }, callback, _errback) => {
    // Signal local DTLS parameters to the server side transport
    socket.emit("CLIENT_CONNECT_RECV_TRANSPORT", dtlsParameters);
    callback();
  });

  return transport;
}

// ----

async function startProducer(transport) {
  const socket = global.server.socket;

  // Get user media as required

  let useAudio = false;
  let useVideo = true;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: useAudio,
    video: useVideo
  });

  ui.localVideo.srcObject = stream;

  // Start mediasoup-client's WebRTC producer(s)

  transport.on("produce", (produceParameters, callback, _errback) => {
    socket.emit("CLIENT_START_RECV_PRODUCER", produceParameters, producerId => {
      callback({ producerId });
    });
  });

  if (useAudio) {
    const audioTrack = stream.getAudioTracks()[0];
    const audioProducer = await transport.produce({ track: audioTrack });
    global.mediasoup.webrtc.audioProducer = audioProducer;
  }

  if (useVideo) {
    const videoTrack = stream.getVideoTracks()[0];
    const videoProducer = await transport.produce({
      track: videoTrack,
      ...CONFIG.mediasoup.client.videoProducer
    });
    global.mediasoup.webrtc.videoProducer = videoProducer;
  }
}

// ----------------------------------------------------------------------------

async function connectKurento() {
  const socket = global.server.socket;
  const device = global.mediasoup.device;

  const socketRequest = SocketPromise(socket);
  await socketRequest({ type: "CLIENT_START_KURENTO" });

  const recvTransport = await startRecvTransport(socket, device);
  await startConsumer(socket, recvTransport, device);
}

// ----

async function startRecvTransport(socket, device) {
  const socketRequest = SocketPromise(socket);
  const response = await socketRequest({ type: "CLIENT_START_SEND_TRANSPORT" });
  const webrtcTransportOptions = response.data;

  console.log("[server] WebRTC SEND transport created");

  const transport = await device.createRecvTransport(webrtcTransportOptions);
  global.mediasoup.webrtc.recvTransport = transport;

  console.log("[mediasoup client] WebRTC RECV transport created");

  transport.on("connect", ({ dtlsParameters }, callback, _errback) => {
    // Signal local DTLS parameters to the server side transport
    socket.emit("CLIENT_CONNECT_SEND_TRANSPORT", dtlsParameters);
    callback();
  });

  return transport;
}

// ----

async function startConsumer(socket, transport, device) {
  const socketRequest = SocketPromise(socket);
  const response = await socketRequest({
    type: "CLIENT_START_SEND_CONSUMER",
    rtpCapabilities: device.rtpCapabilities
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

    console.log("[mediasoup client] WebRTC RECV consumer created");
  }
}

// ----------------------------------------------------------------------------
