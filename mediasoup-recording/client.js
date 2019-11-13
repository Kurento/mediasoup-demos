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
      transport: null,
      audioProducer: null,
      videoProducer: null
    }
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
  console: document.getElementById("uiConsole"),

  // <button>
  startWebRTC: document.getElementById("uiStartWebRTC"),
  startRecording: document.getElementById("uiStartRecording"),
  stopRecording: document.getElementById("uiStopRecording"),

  // <video>
  localVideo: document.getElementById("uiLocalVideo")
};

ui.startWebRTC.onclick = startWebRTC;
ui.startRecording.onclick = startRecording;
ui.stopRecording.onclick = stopRecording;

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

  socket.on("SERVER_PRODUCER_READY", kind => {
    console.log(`Server producer is ready, kind: ${kind}`);
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
}

// ----------------------------------------------------------------------------

async function startWebRTC() {
  console.log("Start WebRTC transmission from browser to mediasoup");

  const device = await startMediasoup();
  const transport = await startTransport(device);
  await startProducer(transport);
}

// ----

async function startMediasoup() {
  const socket = global.server.socket;
  const socketRequest = SocketPromise(socket);
  const uiVCodecName = document.querySelector(
    "input[name='uiVCodecName']:checked"
  ).value;
  const response = await socketRequest({
    type: "CLIENT_START_MEDIASOUP",
    vCodecName: uiVCodecName
  });
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

async function startTransport(device) {
  const socket = global.server.socket;
  const socketRequest = SocketPromise(socket);
  const response = await socketRequest({ type: "CLIENT_START_TRANSPORT" });
  const webrtcTransportOptions = response.data;

  console.log("[server] WebRTC transport created");

  const transport = await device.createSendTransport(webrtcTransportOptions);
  global.mediasoup.webrtc.transport = transport;

  console.log("[client] WebRTC transport created");

  transport.on("connect", ({ dtlsParameters }, callback, _errback) => {
    // Signal local DTLS parameters to the server side transport
    socket.emit("CLIENT_CONNECT_TRANSPORT", dtlsParameters);
    callback();
  });

  return transport;
}

// ----

async function startProducer(transport) {
  const socket = global.server.socket;

  // Get user media as required

  const uiMedia = document.querySelector("input[name='uiMedia']:checked").value;
  let useAudio = false;
  let useVideo = false;
  if (uiMedia.indexOf("audio") !== -1) {
    useAudio = true;
    global.recording.waitForAudio = true;
  }
  if (uiMedia.indexOf("video") !== -1) {
    useVideo = true;
    global.recording.waitForVideo = true;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: useAudio,
    video: useVideo
  });

  ui.localVideo.srcObject = stream;

  // Start mediasoup-client's WebRTC producer(s)

  transport.on("produce", (produceParameters, callback, _errback) => {
    socket.emit("CLIENT_START_PRODUCER", produceParameters, producerId => {
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

// {start,stop}Recording
// =====================

function startRecording() {
  const uiRecorder = document.querySelector("input[name='uiRecorder']:checked")
    .value;
  global.server.socket.emit("CLIENT_START_RECORDING", uiRecorder);
}

function stopRecording() {
  global.server.socket.emit("CLIENT_STOP_RECORDING");
}

// ----------------------------------------------------------------------------
