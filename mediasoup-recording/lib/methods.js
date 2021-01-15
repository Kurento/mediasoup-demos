const createRouter = require("./createRouter");
const recordingFactory = require("./recordingFactory");


module.exports = function(CONFIG)
{
  let mediasoup_router
  let recording
  let webrtc_recvTransport


  return {
    /*
     * Creates a mediasoup worker and router.
     *
     * vCodecName: One of "VP8", "H264".
     */
    START_MEDIASOUP(vCodecName)
    {
      return createRouter(vCodecName, CONFIG.mediasoup)
      .then(function(router)
      {
        mediasoup_router = router;
        recording = recordingFactory(router, CONFIG)

        // At this point, the computed "router.rtpCapabilities" includes the
        // router codecs enhanced with retransmission and RTCP capabilities,
        // and the list of RTP header extensions supported by mediasoup.

        console.log("mediasoup router created");

        console.log("mediasoup router RtpCapabilities:\n%O", router.rtpCapabilities);

        return router.rtpCapabilities;
      })
    },

    // -------------------------------------------------------------------------

    // Creates a mediasoup WebRTC RECV transport
    WEBRTC_RECV_START()
    {
      return mediasoup_router.createWebRtcTransport(
        CONFIG.mediasoup.webrtcTransport
      )
      .then(function(transport)
      {
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
      })
    },

    // -------------------------------------------------------------------------

    // Calls WebRtcTransport.connect() whenever the browser client part is ready
    WEBRTC_RECV_CONNECT(dtlsParameters)
    {
      return webrtc_recvTransport.connect({ dtlsParameters });
    },

    // Calls WebRtcTransport.produce() to start receiving media from the browser
    WEBRTC_RECV_PRODUCE(produceParameters)
    {
      return webrtc_recvTransport.produce(produceParameters)
      .then(recording.addProducer)
    },

    // -------------------------------------------------------------------------

    START_RECORDING(recorder)
    {
      recording.start(recorder)
    },

    STOP_RECORDING()
    {
      recording.stop()
    }
  }
}
