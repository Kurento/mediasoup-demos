const {Device} = require("mediasoup-client");


module.exports = function()
{
  let device

  return {
    whenStarted(routerRtpCapabilities)
    {
      console.log("[server] mediasoup router created");

      device = new Device();

      return device.load({ routerRtpCapabilities });
    },

    createSendTransport(webrtcTransportOptions)
    {
      console.log("[server] WebRTC RECV transport created");

      return device.createSendTransport(webrtcTransportOptions);
    }
  }
}
