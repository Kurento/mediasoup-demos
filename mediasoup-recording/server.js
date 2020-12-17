#!/usr/bin/env node

"use strict";

const Process = require("child_process");
const Https = require("https");
const Fs = require("fs");
const Util = require("util");

const JsonRpcClient = require('@transfast/jsonrpcclient')
const Express = require("express");
const expressWs = require('express-ws');
const FFmpegStatic = require("ffmpeg-static");
const Mediasoup = require("mediasoup");

const CONFIG = require("./config");


// Log whole objects instead of giving up after two levels of nesting
require("util").inspect.defaultOptions.depth = null;


// ----------------------------------------------------------------------------

// Application state
// =================

const global = {
  server: {
    jsonRpcClient: null,
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
    },

    // RTP connection with recording process
    rtp: {
      audioTransport: null,
      audioConsumer: null,
      videoTransport: null,
      videoConsumer: null,
    },
  },

  recProcess: null,
};

// ----------------------------------------------------------------------------

function send(data)
{
  global.server.socket?.send(JSON.stringify(data))
}


// Logging
// =======

// Send all logging to both console and WebSocket
for (const name of ["debug", "log", "info", "warn", "error"]) {
  const method = console[name];

  console[name] = function (...args) {
    method(...args);

    send(global.server.jsonRpcClient?.notification("LOG", [Util.format(...args)]));
  };
}

// ----------------------------------------------------------------------------

// HTTPS server
// ============

const app = Express()

const https = Https.createServer(
{
  cert: Fs.readFileSync(CONFIG.https.cert),
  key: Fs.readFileSync(CONFIG.https.certKey),
}, app);

expressWs(app, https, {
  pingTimeout: CONFIG.https.wsPingTimeout,
  pingInterval: CONFIG.https.wsPingInterval,
});


app.use("/", Express.static(__dirname));

https.on("listening", () => {
  console.log(
    `Web server is listening on https://localhost:${CONFIG.https.port}`
  );
});
https.on("error", (err) => {
  console.error("HTTPS error:", err.message);
});
https.on("tlsClientError", (err) => {
  if (err.message.includes("alert number 46")) {
    // Ignore: this is the client browser rejecting our self-signed certificate
  } else {
    console.error("TLS error:", err);
  }
});
https.listen(CONFIG.https.port);


// ----------------------------------------------------------------------------

// WebSocket server
// ================

app.ws(CONFIG.https.wsPath, function handler(socket, request)
{
  console.log(
    "WebSocket server connected, port: %s",
    request.connection.remotePort
  );

  const jsonRpcClient = JsonRpcClient(methods, send)

  // Accept requests only from a single client
  // TODO fail on HTTP upgrade with 409 CONFLICT or 423 LOCKED
  if(global.server.jsonRpcClient)
  {
    socket.send(JSON.stringify(jsonRpcClient.notification("error",
      ['Client already connected'])));

    return socket.close()
  }

  socket.addEventListener("close", onClose);
  socket.addEventListener("message", function({data})
  {
    console.log('message', data)
    jsonRpcClient.onMessage(JSON.parse(data))
  });

  global.server.jsonRpcClient = jsonRpcClient;
  global.server.socket = socket;
});


// ----

function onClose()
{
  delete global.server.jsonRpcClient;
}


// ----------------------------------------------------------------------------

// Util functions
// ==============

function audioEnabled() {
  return global.mediasoup.webrtc.audioProducer !== null;
}

function videoEnabled() {
  return global.mediasoup.webrtc.videoProducer !== null;
}

function h264Enabled() {
  const codec = global.mediasoup.router.rtpCapabilities.codecs.find(
    (c) => c.mimeType === "video/H264"
  );
  return codec !== undefined;
}

// ----------------------------------------------------------------------------

const methods =
{
  /*
   * Creates a mediasoup worker and router.
   * vCodecName: One of "VP8", "H264".
   */
  async START_MEDIASOUP(vCodecName) {
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

    // Build a RouterOptions based on 'CONFIG.mediasoup.router' and the
    // requested 'vCodecName'
    const routerOptions = {
      mediaCodecs: [],
    };

    const audioCodec = CONFIG.mediasoup.router.mediaCodecs.find(
      (c) => c.mimeType === "audio/opus"
    );
    if (!audioCodec) {
      console.error("Undefined codec mime type: audio/opus -- Check config.js");
      process.exit(1);
    }
    routerOptions.mediaCodecs.push(audioCodec);

    const videoCodec = CONFIG.mediasoup.router.mediaCodecs.find(
      (c) => c.mimeType === `video/${vCodecName}`
    );
    if (!videoCodec) {
      console.error(
        `Undefined codec mime type: video/${vCodecName} -- Check config.js`
      );
      process.exit(1);
    }
    routerOptions.mediaCodecs.push(videoCodec);

    let router;
    try {
      router = await worker.createRouter(routerOptions);
    } catch (err) {
      console.error("BUG:", err);
      process.exit(1);
    }
    global.mediasoup.router = router;

    // At this point, the computed "router.rtpCapabilities" includes the
    // router codecs enhanced with retransmission and RTCP capabilities,
    // and the list of RTP header extensions supported by mediasoup.

    console.log("mediasoup router created");

    console.log("mediasoup router RtpCapabilities:\n%O", router.rtpCapabilities);

    return router.rtpCapabilities;
  },

  async START_RECORDING(recorder) {
    const router = global.mediasoup.router;

    const useAudio = audioEnabled();
    const useVideo = videoEnabled();

    // Start mediasoup's RTP consumer(s)

    if (useAudio) {
      const rtpTransport = await router.createPlainTransport({
        // No RTP will be received from the remote side
        comedia: false,

        // FFmpeg and GStreamer don't support RTP/RTCP multiplexing ("a=rtcp-mux" in SDP)
        rtcpMux: false,

        ...CONFIG.mediasoup.plainTransport,
      });
      global.mediasoup.rtp.audioTransport = rtpTransport;

      await rtpTransport.connect({
        ip: CONFIG.mediasoup.recording.ip,
        port: CONFIG.mediasoup.recording.audioPort,
        rtcpPort: CONFIG.mediasoup.recording.audioPortRtcp,
      });

      console.log(
        "mediasoup AUDIO RTP SEND transport connected: %s:%d <--> %s:%d (%s)",
        rtpTransport.tuple.localIp,
        rtpTransport.tuple.localPort,
        rtpTransport.tuple.remoteIp,
        rtpTransport.tuple.remotePort,
        rtpTransport.tuple.protocol
      );

      console.log(
        "mediasoup AUDIO RTCP SEND transport connected: %s:%d <--> %s:%d (%s)",
        rtpTransport.rtcpTuple.localIp,
        rtpTransport.rtcpTuple.localPort,
        rtpTransport.rtcpTuple.remoteIp,
        rtpTransport.rtcpTuple.remotePort,
        rtpTransport.rtcpTuple.protocol
      );

      const rtpConsumer = await rtpTransport.consume({
        producerId: global.mediasoup.webrtc.audioProducer.id,
        rtpCapabilities: router.rtpCapabilities, // Assume the recorder supports same formats as mediasoup's router
        paused: true,
      });
      global.mediasoup.rtp.audioConsumer = rtpConsumer;

      console.log(
        "mediasoup AUDIO RTP SEND consumer created, kind: %s, type: %s, paused: %s, SSRC: %s CNAME: %s",
        rtpConsumer.kind,
        rtpConsumer.type,
        rtpConsumer.paused,
        rtpConsumer.rtpParameters.encodings[0].ssrc,
        rtpConsumer.rtpParameters.rtcp.cname
      );
    }

    if (useVideo) {
      const rtpTransport = await router.createPlainTransport({
        // No RTP will be received from the remote side
        comedia: false,

        // FFmpeg and GStreamer don't support RTP/RTCP multiplexing ("a=rtcp-mux" in SDP)
        rtcpMux: false,

        ...CONFIG.mediasoup.plainTransport,
      });
      global.mediasoup.rtp.videoTransport = rtpTransport;

      await rtpTransport.connect({
        ip: CONFIG.mediasoup.recording.ip,
        port: CONFIG.mediasoup.recording.videoPort,
        rtcpPort: CONFIG.mediasoup.recording.videoPortRtcp,
      });

      console.log(
        "mediasoup VIDEO RTP SEND transport connected: %s:%d <--> %s:%d (%s)",
        rtpTransport.tuple.localIp,
        rtpTransport.tuple.localPort,
        rtpTransport.tuple.remoteIp,
        rtpTransport.tuple.remotePort,
        rtpTransport.tuple.protocol
      );

      console.log(
        "mediasoup VIDEO RTCP SEND transport connected: %s:%d <--> %s:%d (%s)",
        rtpTransport.rtcpTuple.localIp,
        rtpTransport.rtcpTuple.localPort,
        rtpTransport.rtcpTuple.remoteIp,
        rtpTransport.rtcpTuple.remotePort,
        rtpTransport.rtcpTuple.protocol
      );

      const rtpConsumer = await rtpTransport.consume({
        producerId: global.mediasoup.webrtc.videoProducer.id,
        rtpCapabilities: router.rtpCapabilities, // Assume the recorder supports same formats as mediasoup's router
        paused: true,
      });
      global.mediasoup.rtp.videoConsumer = rtpConsumer;

      console.log(
        "mediasoup VIDEO RTP SEND consumer created, kind: %s, type: %s, paused: %s, SSRC: %s CNAME: %s",
        rtpConsumer.kind,
        rtpConsumer.type,
        rtpConsumer.paused,
        rtpConsumer.rtpParameters.encodings[0].ssrc,
        rtpConsumer.rtpParameters.rtcp.cname
      );
    }

    // ----

    switch (recorder) {
      case "ffmpeg":
        await startRecordingFfmpeg();
        break;
      case "gstreamer":
        await startRecordingGstreamer();
        break;
      case "external":
        await startRecordingExternal();
        break;
      default:
        console.warn("Invalid recorder:", recorder);
        break;
    }

    if (useAudio) {
      const consumer = global.mediasoup.rtp.audioConsumer;
      console.log(
        "Resume mediasoup RTP consumer, kind: %s, type: %s",
        consumer.kind,
        consumer.type
      );
      consumer.resume();
    }
    if (useVideo) {
      const consumer = global.mediasoup.rtp.videoConsumer;
      console.log(
        "Resume mediasoup RTP consumer, kind: %s, type: %s",
        consumer.kind,
        consumer.type
      );
      consumer.resume();
    }
  },

  async STOP_RECORDING() {
    if (global.recProcess) {
      global.recProcess.kill("SIGINT");
    } else {
      stopMediasoupRtp();
    }
  },

  // Calls WebRtcTransport.connect() whenever the browser client part is ready
  async WEBRTC_RECV_CONNECT(dtlsParameters) {
    const transport = global.mediasoup.webrtc.recvTransport;

    await transport.connect({ dtlsParameters });

    console.log("mediasoup WebRTC RECV transport connected");
  },

  // Calls WebRtcTransport.produce() to start receiving media from the browser
  async WEBRTC_RECV_PRODUCE(produceParameters, callback) {
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

    send(global.server.jsonRpcClient.notification("WEBRTC_RECV_PRODUCER_READY",
      [producer.kind]));

    console.log(
      "mediasoup WebRTC RECV producer created, kind: %s, type: %s, paused: %s",
      producer.kind,
      producer.type,
      producer.paused
    );

    console.log(
      "mediasoup WebRTC RECV producer RtpParameters:\n%O",
      producer.rtpParameters
    );

    callback(producer.id);
  },

  // Creates a mediasoup WebRTC RECV transport
  async WEBRTC_RECV_START() {
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
      sctpParameters: transport.sctpParameters,
    };

    console.log(
      "mediasoup WebRTC RECV TransportOptions:\n%O",
      webrtcTransportOptions
    );

    return webrtcTransportOptions;
  }
}

// ----------------------------------------------------------------------------

/* FFmpeg recording
 * ================
 *
 * The intention here is to record the RTP stream as is received from
 * the media server, i.e. WITHOUT TRANSCODING. Hence the "codec copy"
 * commands in FFmpeg.
 *
 * ffmpeg \
 *     -nostdin \
 *     -protocol_whitelist file,rtp,udp \
 *     -fflags +genpts \
 *     -i recording/input-vp8.sdp \
 *     -map 0:a:0 -c:a copy -map 0:v:0 -c:v copy \
 *     -f webm -flags +global_header \
 *     -y recording/output-ffmpeg-vp8.webm
 *
 * NOTES:
 *
 * '-map 0:x:0' ensures that one media of each type is used.
 *
 * FFmpeg 2.x (Ubuntu 16.04 "Xenial") does not support the option
 * "protocol_whitelist", but it is mandatory for FFmpeg 4.x (newer systems).
 */
function startRecordingFfmpeg() {
  // Return a Promise that can be awaited
  let recResolve;
  const promise = new Promise((res, _rej) => {
    recResolve = res;
  });

  const useAudio = audioEnabled();
  const useVideo = videoEnabled();
  const useH264 = h264Enabled();

  // const cmdProgram = "ffmpeg"; // Found through $PATH
  const cmdProgram = FFmpegStatic; // From package "ffmpeg-static"

  let cmdInputPath = `${__dirname}/recording/input-vp8.sdp`;
  let cmdOutputPath = `${__dirname}/recording/output-ffmpeg-vp8.webm`;
  let cmdCodec = "";
  let cmdFormat = "-f webm -flags +global_header";

  // Ensure correct FFmpeg version is installed
  const ffmpegOut = Process.execSync(cmdProgram + " -version", {
    encoding: "utf8",
  });
  const ffmpegVerMatch = /ffmpeg version (\d+)\.(\d+)\.(\d+)/.exec(ffmpegOut);
  let ffmpegOk = false;
  if (ffmpegOut.startsWith("ffmpeg version git")) {
    // Accept any Git build (it's up to the developer to ensure that a recent
    // enough version of the FFmpeg source code has been built)
    ffmpegOk = true;
  } else if (ffmpegVerMatch) {
    const ffmpegVerMajor = parseInt(ffmpegVerMatch[1], 10);
    if (ffmpegVerMajor >= 4) {
      ffmpegOk = true;
    }
  }

  if (!ffmpegOk) {
    console.error("FFmpeg >= 4.0.0 not found in $PATH; please install it");
    process.exit(1);
  }

  if (useAudio) {
    cmdCodec += " -map 0:a:0 -c:a copy";
  }
  if (useVideo) {
    cmdCodec += " -map 0:v:0 -c:v copy";

    if (useH264) {
      cmdInputPath = `${__dirname}/recording/input-h264.sdp`;
      cmdOutputPath = `${__dirname}/recording/output-ffmpeg-h264.mp4`;

      // "-strict experimental" is required to allow storing
      // OPUS audio into MP4 container
      cmdFormat = "-f mp4 -strict experimental";
    }
  }

  // Run process
  const cmdArgStr = [
    "-nostdin",
    "-protocol_whitelist file,rtp,udp",
    // "-loglevel debug",
    // "-analyzeduration 5M",
    // "-probesize 5M",
    "-fflags +genpts",
    `-i ${cmdInputPath}`,
    cmdCodec,
    cmdFormat,
    `-y ${cmdOutputPath}`,
  ]
    .join(" ")
    .trim();

  console.log(`Run command: ${cmdProgram} ${cmdArgStr}`);

  let recProcess = Process.spawn(cmdProgram, cmdArgStr.split(/\s+/));
  global.recProcess = recProcess;

  recProcess.on("error", (err) => {
    console.error("Recording process error:", err);
  });

  recProcess.on("exit", (code, signal) => {
    console.log("Recording process exit, code: %d, signal: %s", code, signal);

    global.recProcess = null;
    stopMediasoupRtp();

    if (!signal || signal === "SIGINT") {
      console.log("Recording stopped");
    } else {
      console.warn(
        "Recording process didn't exit cleanly, output file might be corrupt"
      );
    }
  });

  // FFmpeg writes its logs to stderr
  recProcess.stderr.on("data", (chunk) => {
    chunk
      .toString()
      .split(/\r?\n/g)
      .filter(Boolean) // Filter out empty strings
      .forEach((line) => {
        console.log(line);
        if (line.startsWith("ffmpeg version")) {
          setTimeout(() => {
            recResolve();
          }, 1000);
        }
      });
  });

  return promise;
}

// ----

/* GStreamer recording
 * ===================
 *
 * The intention here is to record the RTP stream as is received from
 * the media server, i.e. WITHOUT TRANSCODING. For that reason, there is
 * no decoder in the pipeline.
 *
 * gst-launch-1.0 \
 *     --eos-on-shutdown \
 *     filesrc location=recording/input-vp8.sdp \
 *         ! sdpdemux timeout=0 name=demux \
 *     webmmux name=mux \
 *         ! filesink location=recording/output-gstreamer-vp8.webm \
 *     demux. ! queue \
 *         ! rtpopusdepay \
 *         ! opusparse \
 *         ! mux. \
 *     demux. ! queue \
 *         ! rtpvp8depay \
 *         ! mux.
 *
 * For H.264, we need to change several parts of the GStreamer pipeline:
 * -> filesrc location=recording/input-h264.sdp
 * -> filesink location=output-gstreamer-h264.mp4
 * -> mp4mux faststart=true (see README for info and why use MP4 Fast-Start)
 * -> rtph264depay and h264parse in the video branch
 */
function startRecordingGstreamer() {
  // Return a Promise that can be awaited
  let recResolve;
  const promise = new Promise((res, _rej) => {
    recResolve = res;
  });

  const useAudio = audioEnabled();
  const useVideo = videoEnabled();
  const useH264 = h264Enabled();

  let cmdInputPath = `${__dirname}/recording/input-vp8.sdp`;
  let cmdOutputPath = `${__dirname}/recording/output-gstreamer-vp8.webm`;
  let cmdMux = "webmmux";
  let cmdAudioBranch = "";
  let cmdVideoBranch = "";

  if (useAudio) {
    // prettier-ignore
    cmdAudioBranch =
      "demux. ! queue \
      ! rtpopusdepay \
      ! opusparse \
      ! mux.";
  }

  if (useVideo) {
    if (useH264) {
      cmdInputPath = `${__dirname}/recording/input-h264.sdp`;
      cmdOutputPath = `${__dirname}/recording/output-gstreamer-h264.mp4`;
      cmdMux = `mp4mux faststart=true faststart-file=${cmdOutputPath}.tmp`;

      // prettier-ignore
      cmdVideoBranch =
        "demux. ! queue \
        ! rtph264depay \
        ! h264parse \
        ! mux.";
    } else {
      // prettier-ignore
      cmdVideoBranch =
        "demux. ! queue \
        ! rtpvp8depay \
        ! mux.";
    }
  }

  // Run process
  const cmdEnv = {
    GST_DEBUG: CONFIG.gstreamer.logLevel,
    ...process.env, // This allows overriding $GST_DEBUG from the shell
  };
  const cmdProgram = "gst-launch-1.0"; // Found through $PATH
  const cmdArgStr = [
    "--eos-on-shutdown",
    `filesrc location=${cmdInputPath}`,
    "! sdpdemux timeout=0 name=demux",
    `${cmdMux} name=mux`,
    `! filesink location=${cmdOutputPath}`,
    cmdAudioBranch,
    cmdVideoBranch,
  ]
    .join(" ")
    .trim();

  console.log(
    `Run command: GST_DEBUG=${cmdEnv.GST_DEBUG} ${cmdProgram} ${cmdArgStr}`
  );

  let recProcess = Process.spawn(cmdProgram, cmdArgStr.split(/\s+/), {
    env: cmdEnv,
  });
  global.recProcess = recProcess;

  recProcess.on("error", (err) => {
    console.error("Recording process error:", err);
  });

  recProcess.on("exit", (code, signal) => {
    console.log("Recording process exit, code: %d, signal: %s", code, signal);

    global.recProcess = null;
    stopMediasoupRtp();

    if (!signal || signal === "SIGINT") {
      console.log("Recording stopped");
    } else {
      console.warn(
        "Recording process didn't exit cleanly, output file might be corrupt"
      );
    }
  });

  // GStreamer writes some initial logs to stdout
  recProcess.stdout.on("data", (chunk) => {
    chunk
      .toString()
      .split(/\r?\n/g)
      .filter(Boolean) // Filter out empty strings
      .forEach((line) => {
        console.log(line);
        if (line.startsWith("Setting pipeline to PLAYING")) {
          setTimeout(() => {
            recResolve();
          }, 1000);
        }
      });
  });

  // GStreamer writes its progress logs to stderr
  recProcess.stderr.on("data", (chunk) => {
    chunk
      .toString()
      .split(/\r?\n/g)
      .filter(Boolean) // Filter out empty strings
      .forEach((line) => {
        console.log(line);
      });
  });

  return promise;
}

// ----

async function startRecordingExternal() {
  // Return a Promise that can be awaited
  let resolve;
  const promise = new Promise((res, _rej) => {
    resolve = res;
  });

  // Countdown to let the user start the external process
  const timeout = 10;
  const sleep = (ms) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };
  for (let time = timeout; time > 0; time--) {
    console.log(`Recording starts in ${time} seconds...`);

    await sleep(1000);
  }

  resolve();

  return promise;
}

// ----------------------------------------------------------------------------

function stopMediasoupRtp() {
  console.log("Stop mediasoup RTP transport and consumer");

  const useAudio = audioEnabled();
  const useVideo = videoEnabled();

  if (useAudio) {
    global.mediasoup.rtp.audioConsumer.close();
    global.mediasoup.rtp.audioTransport.close();
  }

  if (useVideo) {
    global.mediasoup.rtp.videoConsumer.close();
    global.mediasoup.rtp.videoTransport.close();
  }
}

// ----------------------------------------------------------------------------
