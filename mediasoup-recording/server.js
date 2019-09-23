const CONFIG = require("./config");
const Express = require("express");
const Fs = require("fs");
const Https = require("https");
const MediaSoup = require("mediasoup");
const SocketServer = require("socket.io");
const Process = require("child_process");

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
      transport: null,
      audioProducer: null,
      videoProducer: null
    },

    // RTP connection with recording process
    rtp: {
      audioTransport: null,
      audioConsumer: null,
      videoTransport: null,
      videoConsumer: null
    }
  },

  recProcess: null
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
    socket.on("CLIENT_CONNECT_TRANSPORT", handleConnectTransport);
    socket.on("CLIENT_START_PRODUCER", handleStartProducer);
    socket.on("CLIENT_START_RECORDING", handleStartRecording);
    socket.on("CLIENT_STOP_RECORDING", handleStopRecording);
  });
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
    c => c.mimeType === "video/H264"
  );
  return codec !== undefined;
}

// ----------------------------------------------------------------------------

// WebSocket handlers
// ==================

async function handleRequest(request, callback) {
  let responseData = null;

  switch (request.type) {
    case "CLIENT_START_MEDIASOUP":
      responseData = await handleStartMediasoup(request.vCodecName);
      break;
    case "CLIENT_START_TRANSPORT":
      responseData = await handleStartTransport();
      break;
    default:
      console.warn("Invalid request type:", request.type);
      break;
  }

  callback({ type: request.type, data: responseData });
}

// ----------------------------------------------------------------------------

/*
 * Creates a mediasoup worker and router.
 * videoCodec: One of "VP8", "H264".
 */
async function handleStartMediasoup(vCodecName) {
  const worker = await MediaSoup.createWorker(CONFIG.mediasoup.worker);
  global.mediasoup.worker = worker;

  worker.on("died", () => {
    console.error(
      "mediasoup worker died, exit in 3 seconds... [pid:%d]",
      worker.pid
    );
    setTimeout(() => process.exit(1), 3000);
  });

  console.log("Created mediasoup worker [pid:%d]", worker.pid);

  // Build a RouterOptions based on 'CONFIG.mediasoup.router' and the
  // requested 'vCodecName'
  const routerOptions = {
    mediaCodecs: []
  };

  const audioCodec = CONFIG.mediasoup.router.mediaCodecs.find(
    c => c.mimeType === "audio/opus"
  );
  if (!audioCodec) {
    const line = "Undefined codec mime type: audio/opus -- Check config.js";
    console.error(line);
    global.server.socket.emit("SERVER_LOG_LINE", line);
    process.exit(1);
  }
  routerOptions.mediaCodecs.push(audioCodec);

  const videoCodec = CONFIG.mediasoup.router.mediaCodecs.find(
    c => c.mimeType === `video/${vCodecName}`
  );
  if (!videoCodec) {
    const line = `Undefined codec mime type: video/${vCodecName} -- Check config.js`;
    console.error(line);
    global.server.socket.emit("SERVER_LOG_LINE", line);
    process.exit(1);
  }
  routerOptions.mediaCodecs.push(videoCodec);

  const router = await worker.createRouter(routerOptions);
  global.mediasoup.router = router;

  // At this point, the computed router.rtpCapabilities includes the
  // router codecs enhanced with retransmission and RTCP capabilities,
  // and the list of RTP header extensions supported by mediasoup.

  console.log("Created mediasoup router");

  // Uncomment for debug
  // console.log("rtpCapabilities: %s", JSON.stringify(router.rtpCapabilities, null, 2));

  return router.rtpCapabilities;
}

// ----------------------------------------------------------------------------

// Creates a mediasoup WebRTC transport

async function handleStartTransport() {
  const router = global.mediasoup.router;

  const webrtcTransport = await router.createWebRtcTransport(
    CONFIG.mediasoup.webRtcTransport
  );
  global.mediasoup.webrtc.transport = webrtcTransport;

  const webrtcTransportOptions = {
    id: webrtcTransport.id,
    iceParameters: webrtcTransport.iceParameters,
    iceCandidates: webrtcTransport.iceCandidates,
    dtlsParameters: webrtcTransport.dtlsParameters,
    sctpParameters: webrtcTransport.sctpParameters
  };

  console.log("Created mediasoup WebRTC transport");

  // Uncomment for debug
  // console.log("webrtcTransportOptions: %s", JSON.stringify(webrtcTransportOptions, null, 2));

  return webrtcTransportOptions;
}

// ----------------------------------------------------------------------------

// Calls WebRtcTransport.connect() whenever the browser client part is ready

async function handleConnectTransport(dtlsParameters) {
  const webrtcTransport = global.mediasoup.webrtc.transport;

  await webrtcTransport.connect({ dtlsParameters });

  console.log("mediasoup WebRTC transport connected");
}

// ----------------------------------------------------------------------------

// Calls WebrtcTransport.produce() to start receiving media from browser

async function handleStartProducer(produceParameters, callback) {
  const webrtcTransport = global.mediasoup.webrtc.transport;

  const producer = await webrtcTransport.produce(produceParameters);
  switch (producer.kind) {
    case "audio":
      global.mediasoup.webrtc.audioProducer = producer;
      break;
    case "video":
      global.mediasoup.webrtc.videoProducer = producer;
      break;
  }

  global.server.socket.emit("SERVER_PRODUCER_READY", producer.kind);

  console.log(
    "Created mediasoup WebRTC producer, kind: %s, type: %s, paused: %s",
    producer.kind,
    producer.type,
    producer.paused
  );

  // Uncomment for debug
  // console.log("rtpParameters: %s", JSON.stringify(producer.rtpParameters, null, 2));

  callback(producer.id);
}

// ----------------------------------------------------------------------------

async function handleStartRecording(recorder) {
  const router = global.mediasoup.router;
  const hasAudio = audioEnabled();
  const hasVideo = videoEnabled();

  // Start mediasoup's RTP consumer(s)

  if (hasAudio) {
    const rtpAudioTransport = await router.createPlainRtpTransport(
      CONFIG.mediasoup.plainRtpTransport
    );
    global.mediasoup.rtp.audioTransport = rtpAudioTransport;

    await rtpAudioTransport.connect({
      ip: CONFIG.mediasoup.recording.ip,
      port: CONFIG.mediasoup.recording.audioPort
    });

    console.log("Started mediasoup RTP transport for AUDIO");

    const rtpAudioConsumer = await rtpAudioTransport.consume({
      producerId: global.mediasoup.webrtc.audioProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true
    });
    global.mediasoup.rtp.audioConsumer = rtpAudioConsumer;

    console.log(
      "Created mediasoup RTP consumer, kind: %s, type: %s, paused: %s",
      rtpAudioConsumer.kind,
      rtpAudioConsumer.type,
      rtpAudioConsumer.paused
    );
  }

  if (hasVideo) {
    const rtpVideoTransport = await router.createPlainRtpTransport(
      CONFIG.mediasoup.plainRtpTransport
    );
    global.mediasoup.rtp.videoTransport = rtpVideoTransport;

    await rtpVideoTransport.connect({
      ip: CONFIG.mediasoup.recording.ip,
      port: CONFIG.mediasoup.recording.videoPort
    });

    console.log("Started mediasoup RTP transport for VIDEO");

    const rtpVideoConsumer = await rtpVideoTransport.consume({
      producerId: global.mediasoup.webrtc.videoProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true
    });
    global.mediasoup.rtp.videoConsumer = rtpVideoConsumer;

    console.log(
      "Created mediasoup RTP consumer, kind: %s, type: %s, paused: %s",
      rtpVideoConsumer.kind,
      rtpVideoConsumer.type,
      rtpVideoConsumer.paused
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

  if (hasAudio) {
    const consumer = global.mediasoup.rtp.audioConsumer;
    console.log(
      "Resume mediasoup RTP consumer, kind: %s, type: %s",
      consumer.kind,
      consumer.type
    );
    consumer.resume();
  }
  if (hasVideo) {
    const consumer = global.mediasoup.rtp.videoConsumer;
    console.log(
      "Resume mediasoup RTP consumer, kind: %s, type: %s",
      consumer.kind,
      consumer.type
    );
    consumer.resume();
  }
}

// ----

/* FFmpeg recording
 * ================
 *
 * The objective here is to record the RTP stream as is received from
 * the media server, i.e. WITHOUT TRANSCODING. Hence the "codec copy"
 * commands in FFmpeg.
 *
 *
 * NOTES:
 *
 * '-map 0:x:0' ensures that one media of each type is used.
 *
 * FFmpeg 2.x (Ubuntu 16.04 "Xenial") does not support the option
 * "protocol_whitelist", but it is mandatory for FFmpeg 4.x (newer systems).
 *
 *
 * FULL COMMAND (FFmpeg >= 4.x):
 *
 * ffmpeg \
 *     -nostdin \
 *     -protocol_whitelist file,rtp,udp \
 *     -fflags +genpts \
 *     -i recording/input-vp8.sdp \
 *     -map 0:a:0 -c:a copy -map 0:v:0 -c:v copy \
 *     -f webm -flags +global_header \
 *     -y recording/output-ffmpeg-vp8.webm
 */
function startRecordingFfmpeg() {
  // Return a Promise that can be awaited
  let resolve;
  const promise = new Promise((res, _rej) => {
    resolve = res;
  });

  const hasAudio = audioEnabled();
  const hasVideo = videoEnabled();
  const hasH264 = h264Enabled();

  let cmdInputPath = `${__dirname}/recording/input-vp8.sdp`;
  let cmdOutputPath = `${__dirname}/recording/output-ffmpeg-vp8.webm`;
  let cmdCodec = "";
  let cmdFormat = "-f webm -flags +global_header";

  // Ensure correct FFmpeg version is installed
  const ffmpegOut = Process.execSync("ffmpeg -version", { encoding: "utf8" });
  const ffmpegVerMatch = /ffmpeg version (\d+)\.(\d+)\.(\d+)/.exec(ffmpegOut);
  let ffmpegOk = false;
  if (ffmpegOut.startsWith("ffmpeg version git")) {
    // Accept any Git build (it's up to the developer to ensure that a recent
    // enough version of the FFmpeg source code has been built)
    ffmpegOk = true;
  } else if (ffmpegVerMatch) {
    const ffmpegVerMajor = parseInt(ffmpegVerMatch[1], 10);
    const ffmpegVerMinor = parseInt(ffmpegVerMatch[2], 10);
    const ffmpegVerPatch = parseInt(ffmpegVerMatch[3], 10);
    if (ffmpegVerMajor >= 4 && ffmpegVerMinor >= 0 && ffmpegVerPatch >= 0) {
      ffmpegOk = true;
    }
  }

  if (!ffmpegOk) {
    const line = "FFmpeg >= 4.0.0 not found in $PATH; please install it";
    console.error(line);
    global.server.socket.emit("SERVER_LOG_LINE", line);
    process.exit(1);
  }

  if (hasAudio) {
    cmdCodec += " -map 0:a:0 -c:a copy";
  }
  if (hasVideo) {
    cmdCodec += " -map 0:v:0 -c:v copy";

    if (hasH264) {
      cmdInputPath = `${__dirname}/recording/input-h264.sdp`;
      cmdOutputPath = `${__dirname}/recording/output-ffmpeg-h264.mp4`;

      // "-strict experimental" is required to allow storing
      // OPUS audio into MP4 container
      cmdFormat = "-f mp4 -strict experimental";
    }
  }

  // Run process
  const cmdProgram = "ffmpeg"; // Found through $PATH
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
    `-y ${cmdOutputPath}`
  ]
    .join(" ")
    .trim();

  {
    const line = `Run command: ${cmdProgram} ${cmdArgStr}`;
    console.log(line);
    global.server.socket.emit("SERVER_LOG_LINE", line);
  }

  let recProcess = Process.spawn(cmdProgram, cmdArgStr.split(/\s+/));
  global.recProcess = recProcess;

  recProcess.on("error", err => {
    console.error("Recording process error:", err);
  });

  recProcess.on("exit", (code, signal) => {
    console.log("Recording process exit, code: %d, signal: %s", code, signal);

    if (!signal || signal === "SIGINT") {
      console.log("Recording stopped");
    } else {
      console.warn(
        "Recording process didn't exit cleanly, output file might be corrupt"
      );
    }

    stopMediasoupRtp();

    global.recProcess = null;
  });

  recProcess.stderr.on("data", chunk => {
    const str = chunk.toString();
    const lines = str.split(/\r?\n/g);
    lines
      .filter(Boolean) // Filter out empty strings
      .forEach(line => {
        console.log(line);
        global.server.socket.emit("SERVER_LOG_LINE", line);

        if (line.startsWith("ffmpeg version")) {
          setTimeout(() => {
            resolve();
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
 * FULL COMMAND:
 *
 * gst-launch-1.0 \
 *     --eos-on-shutdown \
 *     filesrc location=recording/input-vp8.sdp \
 *         ! sdpdemux timeout=0 name=demux \
 *     webmmux name=mux ! queue \
 *         ! filesink location=recording/output-gstreamer-vp8.webm \
 *     demux. ! queue \
 *         ! rtpopusdepay \
 *         ! opusparse \
 *         ! mux. \
 *     demux. ! queue \
 *         ! rtpvp8depay \
 *         ! mux.
 *
 * NOTES:
 *
 * - For H.264, we need to add "h264parse" and change the muxer to "mp4mux".
 */
function startRecordingGstreamer() {
  // Return a Promise that can be awaited
  let resolve;
  const promise = new Promise((res, _rej) => {
    resolve = res;
  });

  const hasAudio = audioEnabled();
  const hasVideo = videoEnabled();
  const hasH264 = h264Enabled();

  let cmdInputPath = `${__dirname}/recording/input-vp8.sdp`;
  let cmdOutputPath = `${__dirname}/recording/output-gstreamer-vp8.webm`;
  let cmdMux = "webmmux";
  let cmdAudioBranch = "";
  let cmdVideoBranch = "";

  if (hasAudio) {
    cmdAudioBranch =
      "\
      demux. ! queue \
      ! rtpopusdepay \
      ! opusparse \
      ! mux.";
  }

  if (hasVideo) {
    if (hasH264) {
      cmdInputPath = `${__dirname}/recording/input-h264.sdp`;
      cmdOutputPath = `${__dirname}/recording/output-gstreamer-h264.mp4`;
      cmdMux = "mp4mux";
      cmdVideoBranch =
        "\
        demux. ! queue \
        ! rtph264depay \
        ! h264parse \
        ! mux.";
    } else {
      cmdVideoBranch =
        "\
        demux. ! queue \
        ! rtpvp8depay \
        ! mux.";
    }
  }

  // Run process
  const cmdProgram = "gst-launch-1.0"; // Found through $PATH
  const cmdArgStr = [
    "--eos-on-shutdown",
    `filesrc location=${cmdInputPath}`,
    "! sdpdemux timeout=0 name=demux",
    `${cmdMux} name=mux ! queue`,
    `! filesink location=${cmdOutputPath}`,
    cmdAudioBranch,
    cmdVideoBranch
  ]
    .join(" ")
    .trim();

  {
    const line = `Run command: ${cmdProgram} ${cmdArgStr}`;
    console.log(line);
    global.server.socket.emit("SERVER_LOG_LINE", line);
  }

  let recProcess = Process.spawn(cmdProgram, cmdArgStr.split(/\s+/));
  global.recProcess = recProcess;

  recProcess.on("error", err => {
    console.error("Recording process error:", err);
  });

  recProcess.on("exit", (code, signal) => {
    console.log("Recording process exit, code: %d, signal: %s", code, signal);

    if (!signal || signal === "SIGINT") {
      console.log("Recording stopped");
    } else {
      console.warn(
        "Recording process didn't exit cleanly, output file might be corrupt"
      );
    }

    stopMediasoupRtp();

    global.recProcess = null;
  });

  recProcess.stdout.on("data", chunk => {
    const str = chunk.toString();
    const lines = str.split(/\r?\n/g);
    lines
      .filter(Boolean) // Filter out empty strings
      .forEach(line => {
        console.log(line);
        global.server.socket.emit("SERVER_LOG_LINE", line);

        if (line.startsWith("Setting pipeline to PLAYING")) {
          setTimeout(() => {
            resolve();
          }, 1000);
        }
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
  const sleep = ms => {
    return new Promise(resolve => setTimeout(resolve, ms));
  };
  for (let time = timeout; time > 0; time--) {
    const line = `Recording starts in ${time} seconds...`;
    console.log(line);
    global.server.socket.emit("SERVER_LOG_LINE", line);

    await sleep(1000);
  }

  resolve();

  return promise;
}

// ----------------------------------------------------------------------------

async function handleStopRecording() {
  if (global.recProcess) {
    global.recProcess.kill("SIGINT");
  } else {
    stopMediasoupRtp();
  }
}

// ----

function stopMediasoupRtp() {
  const line = "Stop mediasoup RTP transport and consumer";
  console.log(line);
  global.server.socket.emit("SERVER_LOG_LINE", line);

  const hasAudio = audioEnabled();
  const hasVideo = videoEnabled();

  if (hasAudio) {
    global.mediasoup.rtp.audioConsumer.close();
    global.mediasoup.rtp.audioTransport.close();
  }

  if (hasVideo) {
    global.mediasoup.rtp.videoConsumer.close();
    global.mediasoup.rtp.videoTransport.close();
  }
}

// ----------------------------------------------------------------------------
