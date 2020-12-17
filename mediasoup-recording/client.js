"use strict";

const JsonRpcClient = require('@transfast/jsonrpcclient')
const MediasoupClient = require("mediasoup-client");

const CONFIG = require("./config");


// ----------------------------------------------------------------------------

// Global state
// ============

const global = {
  socket: null,

  mediasoup: {
    device: null,

    // WebRTC connection with mediasoup
    webrtc: {
      transport: null,
      audioProducer: null,
      videoProducer: null,
    },
  },

  recording: {
    waitForAudio: false,
    waitForVideo: false,
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
      `webrtc-adapter loaded, browser: '${adapter.browserDetails.browser}', version: '${adapter.browserDetails.version}'`
    );
  } else {
    console.warn("webrtc-adapter is not loaded! an install or config issue?");
  }
});

window.addEventListener("beforeunload", function () {
  console.log("Page unloading, close WebSocket");
  global.socket.close();
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
  global.socket.send(JSON.stringify(data))
}

function connectSocket() {
  const serverUrl = `wss://${window.location.host}${CONFIG.https.wsPath}`;

  console.log("Connect with Application Server:", serverUrl);

  const socket = new WebSocket(serverUrl);

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

  global.socket = socket;
}


// ----------------------------------------------------------------------------

function startWebRTC() {
  console.log("Start WebRTC transmission from browser to mediasoup");

  startMediasoup(function(error)
  {
    if(error) return console.error(error)

    startWebrtcSend(function(error)
    {
      if(error) return console.error(error)
    })
  })
}

function startMediasoup(callback)
{
  const uiVCodecName = document.querySelector(
    "input[name='uiVCodecName']:checked"
  ).value;

  send(jsonRpcClient.request("START_MEDIASOUP", [uiVCodecName],
  async function(error, routerRtpCapabilities)
  {
    if(error) return console.error(error)

    console.log("[server] mediasoup router created");

    let device = null;
    try {
      device = new MediasoupClient.Device();
    } catch (err) {
      return callback(err);
    }
    global.mediasoup.device = device;

    try {
      await device.load({ routerRtpCapabilities });
    } catch (err) {
      return callback(err);
    }

    console.log(
      "mediasoup device created, handlerName: %s, use audio: %s, use video: %s",
      device.handlerName,
      device.canProduce("audio"),
      device.canProduce("video")
    );

    // Uncomment for debug
    // console.log("rtpCapabilities:\n%O", device.rtpCapabilities);

    callback()
  }));
}

function startWebrtcSend(callback)
{
  const device = global.mediasoup.device;

  // mediasoup WebRTC transport
  // --------------------------

  send(jsonRpcClient.request("WEBRTC_RECV_START", [],
    async function(error, webrtcTransportOptions)
    {
      if(error) return console.error(error)

      console.log("[server] WebRTC RECV transport created");

      let transport;
      try {
        transport = device.createSendTransport(webrtcTransportOptions);
      } catch (err) {
        return callback(err);
      }
      global.mediasoup.webrtc.transport = transport;

      console.log("[client] WebRTC SEND transport created");

      // "connect" is emitted upon the first call to transport.produce()
      transport.on("connect", ({ dtlsParameters }, callback, _errback) => {
        // Signal local DTLS parameters to the server side transport
        send(jsonRpcClient.notification("WEBRTC_RECV_CONNECT", [dtlsParameters]));
        callback();
      });

      // "produce" is emitted upon each call to transport.produce()
      transport.on("produce", function(produceParameters, callback, _errback)
      {
        send(jsonRpcClient.request("WEBRTC_RECV_PRODUCE", [produceParameters],
          function(error, {id: producerId, kind})
          {
            if(error) return console.error(error)

            console.log(`Server producer is ready, kind: ${kind}`);

            switch (kind) {
              case "audio":
                global.recording.waitForAudio = false;
                break;
              case "video":
                global.recording.waitForVideo = false;
                break;
            }

            // Update UI
            if(!(global.recording.waitForAudio || global.recording.waitForVideo))
            {
              ui.settings.disabled = true;
              ui.startWebRTC.disabled = true;
              ui.startRecording.disabled = false;
            }

            console.log("[server] WebRTC RECV producer created");

            callback({ producerId });
          })
        );
      });

      // mediasoup WebRTC producer
      // -------------------------

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

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: useAudio,
          video: useVideo,
        });
      } catch (err) {
        return callback(err);
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

      callback()
    }
  ))
}


// ----------------------------------------------------------------------------

function startRecording() {
  const uiRecorder = document.querySelector("input[name='uiRecorder']:checked")
    .value;

  send(jsonRpcClient.notification("START_RECORDING", [uiRecorder]));

  // Update UI
  ui.startRecording.disabled = true;
  ui.stopRecording.disabled = false;
}

function stopRecording() {
  send(jsonRpcClient.notification("STOP_RECORDING"));

  // Update UI
  ui.stopRecording.disabled = true;
}
