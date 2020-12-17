const Process = require("child_process");

const FFmpegStatic = require("ffmpeg-static");
const Mediasoup = require("mediasoup");
const {sync: mkdirp} = require('mkdirp');


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


module.exports = function(CONFIG)
{
  let mediasoup_router
  let recProcess
  let rtp_audioConsumer
  let rtp_audioTransport
  let rtp_videoConsumer
  let rtp_videoTransport
  let webrtc_audioProducer
  let webrtc_recvTransport
  let webrtc_videoProducer


  // Util functions
  // ==============

  function audioEnabled() {
    return webrtc_audioProducer !== null;
  }

  function videoEnabled() {
    return webrtc_videoProducer !== null;
  }

  function h264Enabled() {
    const codec = mediasoup_router.rtpCapabilities.codecs.find(
      (c) => c.mimeType === "video/H264"
    );
    return codec !== undefined;
  }


  // ---------------------------------------------------------------------------

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
   *     -i sdp/input-vp8.sdp \
   *     -map 0:a:0 -c:a copy -map 0:v:0 -c:v copy \
   *     -f webm -flags +global_header \
   *     -y ../recording/output-ffmpeg-vp8.webm
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

    let cmdInputPath = `${__dirname}/sdp/input-vp8.sdp`;
    let cmdOutputPath = `${__dirname}/../recording/output-ffmpeg-vp8.webm`;
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
        cmdInputPath = `${__dirname}/sdp/input-h264.sdp`;
        cmdOutputPath = `${__dirname}/../recording/output-ffmpeg-h264.mp4`;

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

    recProcess = Process.spawn(cmdProgram, cmdArgStr.split(/\s+/));

    recProcess.on("error", (err) => {
      console.error("Recording process error:", err);
    });

    recProcess.on("exit", (code, signal) => {
      console.log("Recording process exit, code: %d, signal: %s", code, signal);

      recProcess = null;
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

  /* GStreamer recording
   * ===================
   *
   * The intention here is to record the RTP stream as is received from
   * the media server, i.e. WITHOUT TRANSCODING. For that reason, there is
   * no decoder in the pipeline.
   *
   * gst-launch-1.0 \
   *     --eos-on-shutdown \
   *     filesrc location=sdp/input-vp8.sdp \
   *         ! sdpdemux timeout=0 name=demux \
   *     webmmux name=mux \
   *         ! filesink location=../recording/output-gstreamer-vp8.webm \
   *     demux. ! queue \
   *         ! rtpopusdepay \
   *         ! opusparse \
   *         ! mux. \
   *     demux. ! queue \
   *         ! rtpvp8depay \
   *         ! mux.
   *
   * For H.264, we need to change several parts of the GStreamer pipeline:
   * -> filesrc location=sdp/input-h264.sdp
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

    let cmdInputPath = `${__dirname}/sdp/input-vp8.sdp`;
    let cmdOutputPath = `${__dirname}/../recording/output-gstreamer-vp8.webm`;
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
        cmdInputPath = `${__dirname}/sdp/input-h264.sdp`;
        cmdOutputPath = `${__dirname}/../recording/output-gstreamer-h264.mp4`;
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

    recProcess = Process.spawn(cmdProgram, cmdArgStr.split(/\s+/), {
      env: cmdEnv,
    });

    recProcess.on("error", (err) => {
      console.error("Recording process error:", err);
    });

    recProcess.on("exit", (code, signal) => {
      console.log("Recording process exit, code: %d, signal: %s", code, signal);

      recProcess = null;
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

  function stopMediasoupRtp() {
    console.log("Stop mediasoup RTP transport and consumer");

    const useAudio = audioEnabled();
    const useVideo = videoEnabled();

    if (useAudio) {
      rtp_audioConsumer.close();
      rtp_audioTransport.close();
    }

    if (useVideo) {
      rtp_videoConsumer.close();
      rtp_videoTransport.close();
    }
  }


  // ---------------------------------------------------------------------------


  return {
    /*
    * Creates a mediasoup worker and router.
    *
    * vCodecName: One of "VP8", "H264".
    */
    async START_MEDIASOUP(vCodecName)
    {
      const worker = await Mediasoup.createWorker(CONFIG.mediasoup.worker);

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
      mediasoup_router = router;

      // At this point, the computed "router.rtpCapabilities" includes the
      // router codecs enhanced with retransmission and RTCP capabilities,
      // and the list of RTP header extensions supported by mediasoup.

      console.log("mediasoup router created");

      console.log("mediasoup router RtpCapabilities:\n%O", router.rtpCapabilities);

      return router.rtpCapabilities;
    },

    async START_RECORDING(recorder)
    {
      const router = mediasoup_router;

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
        rtp_audioTransport = rtpTransport;

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
          producerId: webrtc_audioProducer.id,
          rtpCapabilities: router.rtpCapabilities, // Assume the recorder supports same formats as mediasoup's router
          paused: true,
        });
        rtp_audioConsumer = rtpConsumer;

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
        rtp_videoTransport = rtpTransport;

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
          producerId: webrtc_videoProducer.id,
          rtpCapabilities: router.rtpCapabilities, // Assume the recorder supports same formats as mediasoup's router
          paused: true,
        });
        rtp_videoConsumer = rtpConsumer;

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

      mkdirp(`${__dirname}/../recording`)

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
        const consumer = rtp_audioConsumer;
        console.log(
          "Resume mediasoup RTP consumer, kind: %s, type: %s",
          consumer.kind,
          consumer.type
        );
        consumer.resume();
      }
      if (useVideo) {
        const consumer = rtp_videoConsumer;
        console.log(
          "Resume mediasoup RTP consumer, kind: %s, type: %s",
          consumer.kind,
          consumer.type
        );
        consumer.resume();
      }
    },

    async STOP_RECORDING()
    {
      if (recProcess) {
        recProcess.kill("SIGINT");
      } else {
        stopMediasoupRtp();
      }
    },

    // Calls WebRtcTransport.connect() whenever the browser client part is ready
    async WEBRTC_RECV_CONNECT(dtlsParameters)
    {
      await webrtc_recvTransport.connect({ dtlsParameters });

      console.log("mediasoup WebRTC RECV transport connected");
    },

    // Calls WebRtcTransport.produce() to start receiving media from the browser
    async WEBRTC_RECV_PRODUCE(produceParameters)
    {
      const producer = await webrtc_recvTransport.produce(produceParameters);
      switch (producer.kind) {
        case "audio":
          webrtc_audioProducer = producer;
          break;
        case "video":
          webrtc_videoProducer = producer;
          break;
      }

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

      return {id: producer.id, kind: producer.kind};
    },

    // Creates a mediasoup WebRTC RECV transport
    async WEBRTC_RECV_START()
    {
      const transport = await mediasoup_router.createWebRtcTransport(
        CONFIG.mediasoup.webrtcTransport
      );
      webrtc_recvTransport = transport;

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
}
