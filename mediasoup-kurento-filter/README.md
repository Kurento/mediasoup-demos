mediasoup demo - Kurento filter integration
===========================================

This [mediasoup](https://mediasoup.org/) demo receives the browser's webcam media using WebRTC ([WebRtcTransport](https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransport)); it then sends the video to [Kurento](https://www.kurento.org/) through RTP ([PlainRtpTransport](https://mediasoup.org/documentation/v3/mediasoup/api/#PlainRtpTransport), [RtpEndpoint](https://doc-kurento.readthedocs.io/en/stable/_static/client-jsdoc/module-elements.RtpEndpoint.html)).

*Kurento* will apply a filter to the incoming video ([GStreamerFilter](https://doc-kurento.readthedocs.io/en/stable/_static/client-jsdoc/module-filters.GStreamerFilter.html)), and the result will be sent back to *mediasoup* for presentation.

Check out the [architecture diagram](diagram.png) of this demo.



Setup
-----

mediasoup applications are written for [Node.js](https://nodejs.org/), so you need to have it installed. Follow the [Node.js installation instructions](https://github.com/nodesource/distributions/blob/master/README.md) provided by NodeSource to install Node.js from an official repository; or just grab it from the official [downloads page](https://nodejs.org/en/download/).

This demo uses the Kurento Media Server, so you will need to install it. Just follow the [Kurento installation instructions](https://doc-kurento.readthedocs.io/en/stable/user/installation.html#local-installation). **Note that Kurento is only compatible with either Ubuntu 16.04 "Xenial" or 18.04 "Bionic"**.



Run
---

Run these commands:

```sh
sudo service kurento-media-server start

npm install

npm start
```

Then wait for a message such as "*Server is running: https://127.0.0.1:8080*" and direct your browser to that URL.
