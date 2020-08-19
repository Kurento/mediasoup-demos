# mediasoup demo - Kurento filter integration

In this example, a browser's webcam media is transmitted to [mediasoup](https://mediasoup.org/) using WebRTC ([WebRtcTransport](https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransport)); it is then served as a plain RTP stream ([PlainTransport](https://mediasoup.org/documentation/v3/mediasoup/api/#PlainTransport)) to be received and processed by [Kurento](https://www.kurento.org/) ([RtpEndpoint](https://doc-kurento.readthedocs.io/en/stable/_static/client-jsdoc/module-elements.RtpEndpoint.html)).

Kurento will apply a greyscale filter to the incoming video ([GStreamerFilter](https://doc-kurento.readthedocs.io/en/stable/_static/client-jsdoc/module-filters.GStreamerFilter.html)), and the result will be sent back to mediasoup for presentation.

Check out the architecture diagram of this demo:
![image](diagram.png)



## Setup

mediasoup applications are written for [Node.js](https://nodejs.org/), so you need to have it installed. Follow the [installation instructions](https://github.com/nodesource/distributions/blob/master/README.md) provided by NodeSource to install Node.js from an official repository; or just grab it from the official [downloads page](https://nodejs.org/en/download/).

This demo shows how to integrate mediasoup with Kurento Media Server, so the later must be installed too. Just follow the [Kurento installation instructions](https://doc-kurento.readthedocs.io/en/stable/user/installation.html#local-installation).

**Note that Kurento is only compatible with either Ubuntu 16.04 (Xenial) or 18.04 (Bionic)**.



### Configuring the announced IP

The config parameter `mediasoup.plainTransport.listenIp.announcedIp` is used to tell KMS the IP address where mediasoup can be reached. This IP changes, depending on where KMS is being run. For example, if you run KMS from a remote host (including if you run KMS from a Docker container that doesn't use [Host Networking](https://docs.docker.com/network/host/)), you need to change this parameter to the IP address where KMS can reach and send data to mediasoup.

When using Docker to run KMS, the value of this parameter will depend on the specific networking settings of the Docker daemon:

* If KMS is running from a Linux Docker container that uses Host Networking, the default of `127.0.0.1` will work fine.

* If KMS is running from a Linux Docker container *without* Host Networking, the host will be reachable at the Docker's common network gateway IP, which by default is `172.17.0.1`.

* If using Docker for Mac or Windows, containers cannot reach the host directly through a common network gateway. Instead, the official recommendation (see [Networking features in Docker Desktop for Mac](https://docs.docker.com/docker-for-mac/networking/)) is to resolve the special DNS name `host.docker.internal` *from inside the container itself*. You can get this IP easily, with this command:

  ```sh
  $ docker run --rm alpine nslookup host.docker.internal
  ```

Besides all this, any intermediate NAT should have its UDP ports open so KMS can receive data from mediasoup.



## Run

First, start an instance of Kurento Media Server:

```sh
$ sudo service kurento-media-server start
```

If you are using Docker instead, start your container by following the indications from the [kurento-media-server Docker README](https://hub.docker.com/r/kurento/kurento-media-server/).

Now, run this demo:

```sh
$ npm install
$ npm start
```

Then wait for a message such as `Web server is listening on https://localhost:8080`, and direct your browser to that URL.

You can set the environment variable `DEBUG` to control the log level. For example, enable the *trace* level in order to see all internal mediasoup *RtpParameters* and *RtpCapabilities* objects that are managed by the server:

```sh
$ DEBUG="demo:trace" npm start
```
