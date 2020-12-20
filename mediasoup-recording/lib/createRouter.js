const {createWorker} = require("mediasoup");


function onDied()
{
  console.error(
    "mediasoup worker died, exit in 3 seconds... [pid:%d]",
    this.pid
  );

  setTimeout(process.exit, 3000, 1);
}


module.exports = function(vCodecName, mediasoup)
{
  return createWorker(mediasoup.worker)
  .then(function(worker)
  {
    worker.on("died", onDied);

    console.log("mediasoup worker created [pid:%d]", worker.pid);

    // Build a RouterOptions based on 'mediasoup.router' and the
    // requested 'vCodecName'
    const routerOptions = {
      mediaCodecs: [],
    };

    const audioCodec = mediasoup.router.mediaCodecs.find(
      (c) => c.mimeType === "audio/opus"
    );
    if (!audioCodec) {
      throw new Error("Undefined codec mime type: audio/opus -- Check config.js");
    }
    routerOptions.mediaCodecs.push(audioCodec);

    const videoCodec = mediasoup.router.mediaCodecs.find(
      (c) => c.mimeType === `video/${vCodecName}`
    );
    if (!videoCodec) {
      throw new Error(
        `Undefined codec mime type: video/${vCodecName} -- Check config.js`
      );
    }
    routerOptions.mediaCodecs.push(videoCodec);

    return worker.createRouter(routerOptions);
  })
}
