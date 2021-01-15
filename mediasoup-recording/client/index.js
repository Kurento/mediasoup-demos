"use strict";

const JsonRpcClient = require('@transfast/jsonrpcclient')

const CONFIG = require("../config");

const mediasoupFactory = require('./mediasoupFactory')


const serverUrl = `wss://${window.location.host}${CONFIG.https.wsPath}`;


let recording_waitForAudio
let recording_waitForVideo
let socket


// ----------------------------------------------------------------------------

// HTML UI elements
// ================

const ui = {
  settings: document.getElementById("uiSettings"),
  console: document.getElementById("uiConsole"),

  // <button>
  startWebRTC: document.getElementById("uiStartWebRTC"),
  startRecording: document.getElementById("uiStartRecording"),
  stopRecording: document.getElementById("uiStopRecording"),

  // <video>
  localVideo: document.getElementById("uiLocalVideo"),
};

ui.startWebRTC.onclick = startWebRTC;
ui.startRecording.onclick = startRecording;
ui.stopRecording.onclick = stopRecording;


// ----------------------------------------------------------------------------

window.addEventListener("load", function () {
  console.log("Page loaded, connect WebSocket");
  connectSocket();

  if ("adapter" in window) {
    console.log(
      // eslint-disable-next-line no-undef
      `webrtc-adapter loaded, browser: '${adapter.browserDetails.browser}', ` +
      `version: '${adapter.browserDetails.version}'`
    );
  } else {
    console.warn("webrtc-adapter is not loaded! an install or config issue?");
  }
});

window.addEventListener("beforeunload", function () {
  console.log("Page unloading, close WebSocket");

  socket.close();
});


// ----------------------------------------------------------------------------

const methods =
{
  LOG(log)
  {
    ui.console.value += log + "\n";
    ui.console.scrollTop = ui.console.scrollHeight;
  }
}

const jsonRpcClient = JsonRpcClient(methods, send)


function send(data)
{
  socket.send(JSON.stringify(data))

  return data
}

function connectSocket() {
  console.log("Connect with Application Server:", serverUrl);

  socket = new WebSocket(serverUrl);

  socket.addEventListener("open", function()
  {
    console.log("WebSocket connected");
  });

  socket.addEventListener("close", function()
  {
    console.log("WebSocket closed");
  });

  socket.addEventListener("error", function(err)
  {
    console.error("WebSocket error:", err);
  });

  socket.addEventListener("message", function({data})
  {
    jsonRpcClient.onMessage(JSON.parse(data))
  });
}


// ----------------------------------------------------------------------------

const mediasoup = mediasoupFactory()

function startWebRTC() {
  console.log("Start WebRTC transmission from browser to mediasoup");

  return startMediasoup()
  .then(startWebrtcSend)
  .catch(console.error)
}

function startMediasoup()
{
  const uiVCodecName = document.querySelector(
    "input[name='uiVCodecName']:checked"
  ).value;

  return send(jsonRpcClient.request("START_MEDIASOUP", [uiVCodecName]))
  .then(mediasoup.whenStarted)
}

function startWebrtcSend()
{
  const uiMedia = document.querySelector("input[name='uiMedia']:checked").value;

  let useAudio = false;
  let useVideo = false;

  if (uiMedia.indexOf("audio") !== -1) {
    useAudio = true;
    recording_waitForAudio = true;
  }
  if (uiMedia.indexOf("video") !== -1) {
    useVideo = true;
    recording_waitForVideo = true;
  }

  return send(jsonRpcClient.request("WEBRTC_RECV_START"))
  .then(mediasoup.createSendTransport)
  .then(whenTransport.bind(null, useAudio, useVideo))
  .then(function(stream)
  {
    ui.localVideo.srcObject = stream;
  })
}


// ----------------------------------------------------------------------------

function onConnect({ dtlsParameters }, callback, errback)
{
  // Signal local DTLS parameters to the server side transport
  send(jsonRpcClient.request("WEBRTC_RECV_CONNECT", [dtlsParameters]))
  .then(callback, errback)
}

function onProduce(produceParameters, callback, errback)
{
  send(jsonRpcClient.request("WEBRTC_RECV_PRODUCE", [produceParameters]))
  .then(whenProduce)
  .then(function(producerId)
  {
    callback({ producerId });
  }, errback)
}

function whenProduce({id, kind})
{
  console.log(`Server producer is ready, kind: ${kind}`);

  switch (kind) {
    case "audio":
      recording_waitForAudio = false;
      break;

    case "video":
      recording_waitForVideo = false;
      break;
  }

  // Update UI
  if(!(recording_waitForAudio || recording_waitForVideo))
  {
    ui.settings.disabled = true;
    ui.startWebRTC.disabled = true;
    ui.startRecording.disabled = false;
  }

  console.log("[server] WebRTC RECV producer created");

  return id
}

function whenTransport(useAudio, useVideo, transport)
{
  console.log("[client] WebRTC SEND transport created");

  // "connect" is emitted upon the first call to transport.produce()
  transport.on("connect", onConnect);

  // "produce" is emitted upon each call to transport.produce()
  transport.on("produce", onProduce);

  // Get user media as required

  if(!(useAudio || useVideo)) return

  return navigator.mediaDevices.getUserMedia({
    audio: useAudio,
    video: useVideo,
  })
  .then(function(stream)
  {
    // Start mediasoup-client's WebRTC producer(s)

    const audioTrack = stream.getAudioTracks()[0];
    const videoTrack = stream.getVideoTracks()[0];

    return Promise.all([
      useAudio && transport.produce({ track: audioTrack }),
      useVideo && transport.produce({
        track: videoTrack,
        ...CONFIG.mediasoup.client.videoProducer,
      })
    ])
    .then(function()
    {
      return stream
    })
  })
}


// ----------------------------------------------------------------------------

function startRecording() {
  const {value} = document.querySelector("input[name='uiRecorder']:checked")

  send(jsonRpcClient.notification("START_RECORDING", [value]));

  // Update UI
  ui.startRecording.disabled = true;
  ui.stopRecording.disabled = false;
}

function stopRecording() {
  send(jsonRpcClient.notification("STOP_RECORDING"));

  // Update UI
  ui.stopRecording.disabled = true;
}
