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
    webrtcTransport: null,
    webrtcAudioProducer: null,
    webrtcVideoProducer: null
  },
  recording: {
    rtpAudioTransport: null,
    rtpVideoTransport: null,
    rtpAudioConsumer: null,
    rtpVideoConsumer: null,
    recProcess: null
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
    socket.on("CONNECT_TRANSPORT", handleConnectTransport);
    socket.on("START_PRODUCER", handleStartProducer);
    socket.on("START_RECORDING", handleStartRecording);
    socket.on("STOP_RECORDING", handleStopRecording);
  });
}

// ----------------------------------------------------------------------------

// WebSocket handlers
// ==================

async function handleRequest(request, callback) {
  let responseData = null;

  switch (request.type) {
    case "START_MEDIASOUP":
      responseData = await handleStartMediasoup();
      break;
    case "START_TRANSPORT":
      responseData = await handleStartTransport();
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

  const router = await worker.createRouter(CONFIG.mediasoup.router);
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
  global.mediasoup.webrtcTransport = webrtcTransport;

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
  const webrtcTransport = global.mediasoup.webrtcTransport;

  await webrtcTransport.connect({ dtlsParameters });

  console.log("mediasoup WebRTC transport connected");
}

// ----------------------------------------------------------------------------

// Calls WebrtcTransport.produce() to start receiving media from browser

async function handleStartProducer(produceParameters, callback) {
  const webrtcTransport = global.mediasoup.webrtcTransport;

  const producer = await webrtcTransport.produce(produceParameters);
  switch (producer.kind) {
    case "audio":
      global.mediasoup.webrtcAudioProducer = producer;
      break;
    case "video":
      global.mediasoup.webrtcVideoProducer = producer;
      break;
  }

  global.server.socket.emit("PRODUCER_READY", producer.kind);

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

function audioEnabled() {
  return global.mediasoup.webrtcAudioProducer !== null;
}

function videoEnabled() {
  return global.mediasoup.webrtcVideoProducer !== null;
}

async function handleStartRecording(recorder) {
  const router = global.mediasoup.router;
  const hasAudio = audioEnabled();
  const hasVideo = videoEnabled();

  // Start mediasoup's RTP consumer(s)

  if (hasAudio) {
    const webrtcAudioProducer = global.mediasoup.webrtcAudioProducer;
    const rtpAudioTransport = await router.createPlainRtpTransport(
      CONFIG.mediasoup.plainRtpTransport
    );
    global.recording.rtpAudioTransport = rtpAudioTransport;

    await rtpAudioTransport.connect({
      ip: CONFIG.mediasoup.recording.ip,
      port: CONFIG.mediasoup.recording.audioPort
    });

    console.log("Started mediasoup RTP transport for AUDIO");

    const rtpAudioConsumer = await rtpAudioTransport.consume({
      producerId: webrtcAudioProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true
    });
    global.recording.rtpAudioConsumer = rtpAudioConsumer;

    console.log(
      "Created mediasoup RTP consumer, kind: %s, type: %s, paused: %s",
      rtpAudioConsumer.kind,
      rtpAudioConsumer.type,
      rtpAudioConsumer.paused
    );
  }

  if (hasVideo) {
    const webrtcVideoProducer = global.mediasoup.webrtcVideoProducer;
    const rtpVideoTransport = await router.createPlainRtpTransport(
      CONFIG.mediasoup.plainRtpTransport
    );
    global.recording.rtpVideoTransport = rtpVideoTransport;

    await rtpVideoTransport.connect({
      ip: CONFIG.mediasoup.recording.ip,
      port: CONFIG.mediasoup.recording.videoPort
    });

    console.log("Started mediasoup RTP transport for VIDEO");

    const rtpVideoConsumer = await rtpVideoTransport.consume({
      producerId: webrtcVideoProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true
    });
    global.recording.rtpVideoConsumer = rtpVideoConsumer;

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
    const consumer = global.recording.rtpAudioConsumer;
    console.log(
      "Resume mediasoup RTP consumer, kind: %s, type: %s",
      consumer.kind,
      consumer.type
    );
    consumer.resume();
  }
  if (hasVideo) {
    const consumer = global.recording.rtpVideoConsumer;
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
 *     -i recording/input.sdp \
 *     -map 0:a:0 -map 0:v:0 -acodec copy -vcodec copy \
 *     -flags +global_header \
 *     -y recording/output.webm
 */
function startRecordingFfmpeg() {
  // Return a Promise that can be awaited
  let resolve;
  const promise = new Promise((res, _rej) => {
    resolve = res;
  });

  const hasAudio = audioEnabled();
  const hasVideo = videoEnabled();

  let cmdProtocol = "";
  let cmdCodec = "-an -vn";

  // Set protocol
  const ffmpegOut = Process.execSync("ffmpeg -version", { encoding: "utf8" });
  const ffmpegVersMatch = /ffmpeg version (\d+)\.\d+\.\d+/.exec(ffmpegOut);
  if (ffmpegVersMatch) {
    const ffmpegVers = parseInt(ffmpegVersMatch[1], 10);
    if (ffmpegVers >= 4) {
      cmdProtocol = "-protocol_whitelist file,rtp,udp";
    }
  } else {
    const line = "Cannot get FFmpeg version; is it installed?";
    console.error(line);
    global.server.socket.emit("LOG_LINE", line);

    process.exit(1);
  }

  // Set codec
  if (hasAudio && hasVideo) {
    cmdCodec = "-map 0:a:0 -map 0:v:0 -acodec copy -vcodec copy";
  } else if (hasAudio) {
    cmdCodec = "-acodec copy -vn";
  } else if (hasVideo) {
    cmdCodec = "-vcodec copy -an";
  }

  // Run process
  const cmdProgram = "ffmpeg"; // Found through $PATH
  const cmdArgStr = [
    cmdProtocol,
    "-nostdin",
    // "-loglevel debug",
    // "-analyzeduration 5M",
    // "-probesize 5M",
    "-fflags +genpts",
    `-i ${__dirname}/recording/input.sdp`,
    cmdCodec,
    "-f webm -flags +global_header",
    `-y ${__dirname}/recording/output.webm`
  ]
    .join(" ")
    .trim();

  {
    const line = `Run command: ${cmdProgram} ${cmdArgStr}`;
    console.log(line);
    global.server.socket.emit("LOG_LINE", line);
  }

  let recProcess = Process.spawn(cmdProgram, cmdArgStr.split(/\s+/));
  global.recording.recProcess = recProcess;

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

    global.recording.recProcess = null;
  });

  recProcess.stderr.on("data", chunk => {
    const str = chunk.toString();
    const lines = str.split(/\r?\n/g);
    lines
      .filter(Boolean) // Filter out empty strings
      .forEach(line => {
        console.log(line);
        global.server.socket.emit("LOG_LINE", line);

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
 *     filesrc location=recording/input.sdp \
 *         ! sdpdemux timeout=0 name=demux \
 *     webmmux name=mux \
 *         ! filesink location=recording/output.webm async=false sync=false \
 *     demux. ! queue \
 *         ! rtpopusdepay \
 *         ! opusparse \
 *         ! mux. \
 *     demux. ! queue \
 *         ! rtpvp8depay \
 *         ! mux.
 */
function startRecordingGstreamer() {
  // Return a Promise that can be awaited
  let resolve;
  const promise = new Promise((res, _rej) => {
    resolve = res;
  });

  const hasAudio = audioEnabled();
  const hasVideo = videoEnabled();

  let cmdAudioBranch = "";
  let cmdVideoBranch = "";

  if (hasAudio) {
    cmdAudioBranch =
      "demux. ! queue \
      ! rtpopusdepay \
      ! opusparse \
      ! mux.";
  }

  if (hasVideo) {
    cmdVideoBranch = "demux. ! queue \
      ! rtpvp8depay \
      ! mux.";
  }

  // Run process
  const cmdProgram = "gst-launch-1.0"; // Found through $PATH
  const cmdArgStr = [
    "--eos-on-shutdown",
    `filesrc location=${__dirname}/recording/input.sdp`,
    "! sdpdemux timeout=0 name=demux",
    "webmmux name=mux",
    `! filesink location=${__dirname}/recording/output.webm async=false sync=false`,
    cmdAudioBranch,
    cmdVideoBranch
  ]
    .join(" ")
    .trim();

  {
    const line = `Run command: ${cmdProgram} ${cmdArgStr}`;
    console.log(line);
    global.server.socket.emit("LOG_LINE", line);
  }

  let recProcess = Process.spawn(cmdProgram, cmdArgStr.split(/\s+/));
  global.recording.recProcess = recProcess;

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

    global.recording.recProcess = null;
  });

  recProcess.stdout.on("data", chunk => {
    const str = chunk.toString();
    const lines = str.split(/\r?\n/g);
    lines
      .filter(Boolean) // Filter out empty strings
      .forEach(line => {
        console.log(line);
        global.server.socket.emit("LOG_LINE", line);

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
    global.server.socket.emit("LOG_LINE", line);

    await sleep(1000);
  }

  resolve();

  return promise;
}

// ----------------------------------------------------------------------------

async function handleStopRecording() {
  if (global.recording.recProcess) {
    global.recording.recProcess.kill("SIGINT");
  } else {
    stopMediasoupRtp();
  }
}

// ----

function stopMediasoupRtp() {
  const line = "Stop mediasoup RTP transport and consumer";
  console.log(line);
  global.server.socket.emit("LOG_LINE", line);

  const hasAudio = audioEnabled();
  const hasVideo = videoEnabled();

  if (hasAudio) {
    global.recording.rtpAudioConsumer.close();
    global.recording.rtpAudioTransport.close();
  }

  if (hasVideo) {
    global.recording.rtpVideoConsumer.close();
    global.recording.rtpVideoTransport.close();
  }
}

// ----------------------------------------------------------------------------
