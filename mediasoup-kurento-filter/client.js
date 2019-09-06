const CONFIG = require("./config");
const MediasoupClient = require("mediasoup-client");
const SocketClient = require("socket.io-client");
const SocketPromise = require("socket.io-promise").default;

// Global state
// A real application would store this in user session(s)
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

  // <video>
  localVideo: document.getElementById("uiLocalVideo"),
  remoteVideo: document.getElementById("uiRemoteVideo")
};

ui.startWebRTC.onclick = startWebRTC;
ui.connectKurento.onclick = connectKurento;

// ----------------------------------------------------------------------------

async function startWebRTC() {
  console.log("Start WebRTC transmission from browser to mediasoup");

  const socket = connectSocket();
  const device = await startMediasoup(socket);

  const sendTransport = await startSendTransport(socket, device);
  await startProducer(socket, sendTransport);

  // ... do something clever with all this!
}

// ----

function connectSocket() {
  const serverUrl = `https://${CONFIG.https.ip}:${CONFIG.https.port}`;

  const socket = SocketClient(serverUrl, {
    path: CONFIG.https.wsPath,
    transports: ["websocket"]
  });
  global.server.socket = socket;

  socket.on("connect", () => {
    console.log(`WebSocket connected to server: ${serverUrl}`);
  });

  socket.on("error", err => {
    console.error(`WebSocket error: ${err}`);
  });

  socket.on("SERVER_LOG_LINE", line => {
    ui.console.value += line + "\n";
    ui.console.scrollTop = ui.console.scrollHeight;
  });

  return socket;
}

// ----

async function startMediasoup(socket) {
  const socketRequest = SocketPromise(socket);
  const response = await socketRequest({ type: "CLIENT_START_MEDIASOUP" });
  const routerRtpCapabilities = response.data;

  console.log("[Server] mediasoup router created");

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
    "mediasoup device created, handlerName: %s, has audio: %s, has video: %s",
    device.handlerName,
    device.canProduce("audio"),
    device.canProduce("video")
  );

  // Uncomment for debug
  // console.log("rtpCapabilities:\n%s", JSON.stringify(device.rtpCapabilities, null, 2));

  return device;
}

// ----

async function startSendTransport(socket, device) {
  const socketRequest = SocketPromise(socket);
  const response = await socketRequest({ type: "CLIENT_START_RECV_TRANSPORT" });
  const webrtcTransportOptions = response.data;

  console.log("[mediasoup server] WebRTC RECV transport created");

  const transport = await device.createSendTransport(webrtcTransportOptions);
  global.mediasoup.webrtc.sendTransport = transport;

  console.log(
    "[mediasoup client] WebRTC SEND transport created, direction:",
    transport.direction
  );

  transport.on("connect", ({ dtlsParameters }, callback, _errback) => {
    // Signal local DTLS parameters to the server side transport
    socket.emit("CLIENT_CONNECT_RECV_TRANSPORT", dtlsParameters);
    callback();
  });

  return transport;
}

// ----

async function startProducer(socket, transport) {
  // Get user media as required

  // const uiMedia = document.querySelector("input[name='uiMedia']:checked").value;
  let hasAudio = false;
  let hasVideo = true;
  // if (uiMedia.indexOf("audio") !== -1) {
  //   hasAudio = true;
  // }
  // if (uiMedia.indexOf("video") !== -1) {
  //   hasVideo = true;
  // }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: hasAudio,
    video: hasVideo
  });

  ui.localVideo.srcObject = stream;

  // Start mediasoup-client's WebRTC producer(s)

  transport.on("produce", (produceParameters, callback, _errback) => {
    socket.emit("CLIENT_START_RECV_PRODUCER", produceParameters, producerId => {
      callback({ producerId });
    });
  });

  if (hasAudio) {
    const audioTrack = stream.getAudioTracks()[0];
    const audioProducer = await transport.produce({ track: audioTrack });
    global.mediasoup.webrtc.audioProducer = audioProducer;
  }

  if (hasVideo) {
    const videoTrack = stream.getVideoTracks()[0];
    const videoProducer = await transport.produce({
      track: videoTrack,
      ...CONFIG.mediasoup.client.videoProducer
    });
    global.mediasoup.webrtc.videoProducer = videoProducer;
  }
}

// ----------------------------------------------------------------------------

async function startRecvTransport(socket, device) {
  const socketRequest = SocketPromise(socket);
  const response = await socketRequest({ type: "CLIENT_START_SEND_TRANSPORT" });
  const webrtcTransportOptions = response.data;

  console.log("[mediasoup server] WebRTC SEND transport created");

  const transport = await device.createRecvTransport(webrtcTransportOptions);
  global.mediasoup.webrtc.recvTransport = transport;

  console.log(
    "[mediasoup client] WebRTC RECV transport created, direction:",
    transport.direction
  );

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

  console.log("[mediasoup server] WebRTC SEND consumer created");

  let hasAudio = false;
  let hasVideo = true;

  // Start mediasoup-client's WebRTC consumer(s)

  const stream = new MediaStream();
  ui.remoteVideo.srcObject = stream;

  if (hasAudio) {
    // ...
  }

  if (hasVideo) {
    const consumer = await transport.consume(webrtcConsumerOptions);
    global.mediasoup.webrtc.videoConsumer = consumer;
    stream.addTrack(consumer.track);

    console.log("[mediasoup client] WebRTC RECV consumer created");
  }
}

// ----------------------------------------------------------------------------

// connectKurento
// ==============

async function connectKurento() {
  const socket = global.server.socket;
  const device = global.mediasoup.device;

  const socketRequest = SocketPromise(socket);
  await socketRequest({
    type: "CLIENT_CONNECT_KURENTO"
  });

  const recvTransport = await startRecvTransport(socket, device);
  await startConsumer(socket, recvTransport, device);
}

// ----------------------------------------------------------------------------
