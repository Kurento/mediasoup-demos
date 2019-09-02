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
    webrtcTransport: null,
    webrtcAudioProducer: null,
    webrtcVideoProducer: null
  },
  recording: {
    waitForAudio: false,
    waitForVideo: false
  }
};

// ----------------------------------------------------------------------------

// HTML UI elements
// ================

const ui = {
  startWebRTC: document.getElementById("uiStartWebRTC"),
  startRecording: document.getElementById("uiStartRecording"),
  stopRecording: document.getElementById("uiStopRecording")
};

ui.startWebRTC.onclick = startWebRTC;
ui.startRecording.onclick = startRecording;
ui.stopRecording.onclick = stopRecording;

// ----------------------------------------------------------------------------

// startWebRTC
// ===========

async function startWebRTC() {
  console.log("Start WebRTC transmission from browser to mediasoup");

  const socket = connectSocket();
  const device = await startMediasoup(socket);
  const transport = await startTransport(socket, device);
  await startProducer(socket, transport);

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

  socket.on("PRODUCER_READY", kind => {
    console.log(`PRODUCER_READY, kind: ${kind}`);
    switch (kind) {
      case "audio":
        global.recording.waitForAudio = false;
        break;
      case "video":
        global.recording.waitForVideo = false;
        break;
    }

    if (!global.recording.waitForAudio && !global.recording.waitForVideo) {
      ui.startRecording.disabled = false;
      ui.stopRecording.disabled = false;
    }
  });

  socket.on("LOG_LINE", line => {
    const uiConsole = document.getElementById("uiConsole");
    const oldLog = uiConsole.value;
    uiConsole.value = oldLog + line + "\n";
    uiConsole.scrollTop = uiConsole.scrollHeight;
  });

  return socket;
}

// ----

async function startMediasoup(socket) {
  const socketRequest = SocketPromise(socket);
  const response = await socketRequest({ type: "START_MEDIASOUP" });
  const rtpCapabilities = response.data;

  console.log("[Server] Created mediasoup router");

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
    await device.load({ routerRtpCapabilities: rtpCapabilities });
  } catch (err) {
    if (err.name === "InvalidStateError") {
      console.warn("mediasoup device was already loaded");
    }
  }

  console.log(
    "Created mediasoup device, handlerName: %s, has audio: %s, has video: %s",
    device.handlerName,
    device.canProduce("audio"),
    device.canProduce("video")
  );

  // Uncomment for debug
  // console.log("rtpCapabilities: %s", JSON.stringify(device.rtpCapabilities, null, 2));

  return device;
}

// ----

async function startTransport(socket, device) {
  const socketRequest = SocketPromise(socket);
  const response = await socketRequest({ type: "START_TRANSPORT" });
  const webrtcTransportOptions = response.data;

  let transport = null;

  console.log("[Server] Created mediasoup WebRTC transport");

  transport = await device.createSendTransport(webrtcTransportOptions);
  global.mediasoup.webrtcTransport = transport;

  transport.on("connect", ({ dtlsParameters }, callback, _errback) => {
    // Signal local DTLS parameters to the server side transport
    socket.emit("CONNECT_TRANSPORT", dtlsParameters);
    callback();
  });

  console.log(
    "Created mediasoup device transport, direction: %s",
    transport.direction
  );

  return transport;
}

// ----

async function startProducer(socket, transport) {
  // Get user media as required

  const uiMedia = document.querySelector("input[name='uiMedia']:checked").value;
  let hasAudio = false;
  let hasVideo = false;
  if (uiMedia.indexOf("audio") !== -1) {
    hasAudio = true;
    global.recording.waitForAudio = true;
  }
  if (uiMedia.indexOf("video") !== -1) {
    hasVideo = true;
    global.recording.waitForVideo = true;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: hasAudio,
    video: hasVideo
  });

  const uiLocalVideo = document.getElementById("uiLocalVideo");
  uiLocalVideo.srcObject = stream;

  // Start mediasoup-client's WebRTC producer(s)

  transport.on("produce", (produceParameters, callback, _errback) => {
    socket.emit("START_PRODUCER", produceParameters, producerId => {
      callback({ producerId });
    });
  });

  if (hasAudio) {
    const audioTrack = stream.getAudioTracks()[0];
    const audioProducer = await transport.produce({ track: audioTrack });
    global.mediasoup.webrtcAudioProducer = audioProducer;
  }

  if (hasVideo) {
    const videoTrack = stream.getVideoTracks()[0];
    const videoProducer = await transport.produce({
      track: videoTrack,
      ...CONFIG.mediasoup.client.videoProducer
    });
    global.mediasoup.webrtcVideoProducer = videoProducer;
  }
}

// ----------------------------------------------------------------------------

// {start,stop}Recording
// =====================

function startRecording() {
  const uiRecorder = document.querySelector("input[name='uiRecorder']:checked")
    .value;
  global.server.socket.emit("START_RECORDING", uiRecorder);
}

function stopRecording() {
  global.server.socket.emit("STOP_RECORDING");
}

// ----------------------------------------------------------------------------
