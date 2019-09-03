mediasoup recording
===================

In this example, a browser's webcam media is transmitted to *mediasoup* using WebRTC ([WebRtcTransport](https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransport)); it is then served as a plain RTP stream ([PlainRtpTransport](https://mediasoup.org/documentation/v3/mediasoup/api/#PlainRtpTransport)) to be received and recorded by an external process.

**The media is not re-encoded at any moment**. This is an important detail, because you want recording to take as little resources as possible. For that, the internal FFmpeg and GStreamer commands are carefully written to make sure that the media packets are received via RTP and get stored as-is to the output recording file.



Setup
-----

mediasoup applications are written for [Node.js](https://nodejs.org/), so you need to have it installed. Follow the [installation instructions](https://github.com/nodesource/distributions/blob/master/README.md) provided by NodeSource to install Node.js from an official repository; or just grab it from the official [downloads page](https://nodejs.org/en/download/).

The recording process can be chosen between [GStreamer](https://gstreamer.freedesktop.org/) and [FFmpeg](https://ffmpeg.org/). To use these, you must install them in your system. For example, for Debian/Ubuntu systems, run the following commands in a terminal:

```sh
sudo apt-get update

sudo apt-get install --yes \
    ffmpeg \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-tools
```



Configure
---------

You can choose between using **VP8** or **H.264** for the video encoding, which are the two standard codecs typically used for WebRTC. For this, edit the file [config.js](config.js) and un/comment the corresponding part in the `mediaCodecs` section:

*For VP8*:

```js
mediaCodecs: [
  {
    kind: "audio",
    mimeType: "audio/opus",
    preferredPayloadType: 111,
    clockRate: 48000,
    channels: 2
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    preferredPayloadType: 96,
    clockRate: 90000
  }
  // {
  //   kind: "video",
  //   mimeType: "video/H264",
  //   preferredPayloadType: 125,
  //   clockRate: 90000,
  //   parameters: {
  //     "level-asymmetry-allowed": 1,
  //     "packetization-mode": 1,
  //     "profile-level-id": "42e01f"
  //   }
  // }
]
```

*For H.264*:

```js
mediaCodecs: [
  {
    kind: "audio",
    mimeType: "audio/opus",
    preferredPayloadType: 111,
    clockRate: 48000,
    channels: 2
  },
  // {
  //   kind: "video",
  //   mimeType: "video/VP8",
  //   preferredPayloadType: 96,
  //   clockRate: 90000
  // }
  {
    kind: "video",
    mimeType: "video/H264",
    preferredPayloadType: 125,
    clockRate: 90000,
    parameters: {
      "level-asymmetry-allowed": 1,
      "packetization-mode": 1,
      "profile-level-id": "42e01f"
    }
  }
]
```

When *VP8* is enabled, the recording output file format will be **WEBM**. Similarly, *H.264* will use **MP4** as recording file format.

**WARNING**: Right now, recording OPUS audio into MP4 container is not working with FFmpeg, so if you enable H.264 and choose the FFmpeg recorder, then resulting MP4 files won't have working audio.



Run
---

Run these commands:

```sh
npm install

npm start
```

Then wait for a message such as "*Server is running: https://127.0.0.1:8080*" and direct your browser to that URL.



Note for users of VLC
---------------------

**VLC >= 3.0 is required**.

Versions of [VLC](https://www.videolan.org/vlc/index.html) older than 3.0 are not able to properly play OPUS audio that is stored into a Matroska/WEBM container, which is the format used by this demo to store recordings.

If you use an older Linux distro that comes with VLC 2.x, then you will have to look into how to install a more up to date version of VLC, or just use a different media player.

For example, in Ubuntu systems, you can run the latest `snap`-based VLC version, with:

```sh
sudo apt-get update
sudo apt-get install snapd
sudo snap install vlc
export PATH="/snap/bin:$PATH"
vlc
```
