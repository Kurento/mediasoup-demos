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

You can choose between using **VP8** or **H.264** for the video encoding, which are the two standard codecs typically used for WebRTC. For this, select the desired codec before starting the WebRTC call with the browser.

When *VP8* is enabled, the recording output file format will be **WEBM**. Similarly, *H.264* will use **MP4** as recording file format.

**WARNING**: Right now, recording OPUS audio into MP4 container is not working with FFmpeg, so if you enable H.264 and choose the FFmpeg recorder, then resulting MP4 files won't have working audio.



Run
---

Run these commands:

```sh
npm install

npm start
```

Then wait for a message such as "`Server is running: https://127.0.0.1:8080`", and direct your browser to that URL.



Note for recording with FFmpeg
------------------------------

**FFmpeg >= 4.0 is required**.

Most Linux distros come with too old versions of FFmpeg, so the recommendation is to download an up-to-date static build from [John Van Sickle's website](https://www.johnvansickle.com/ffmpeg/).

For example, in Ubuntu systems, you can download the latest FFmpeg release with these commands:

```sh
cd /tmp/
wget "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
tar Jxf ffmpeg-release-amd64-static.tar.xz
cd ffmpeg-*-amd64-static/
sudo cp ffmpeg /usr/local/bin/
```



**WARNING: FFmpeg cannot record in MP4**.

This is a Work In Progress: the support for OPUS audio in MP4 container doesn't work, even in latest versions. This is due to a bug with the OPUS metadata handling, which was reported and is being tracked here:

* [mp4 opus invalid extradata size (missing header)](http://ffmpeg.org/pipermail/ffmpeg-user/2019-September/045274.html)

We are waiting for a fix that solves the issue. Meanwhile, if you try FFmpeg as the recording tool, make sure that the selected container format is WEBM, or that the stream doesn't contain audio.



Note for users of VLC
---------------------

**VLC >= 3.0 is required**.

Versions of [VLC](https://www.videolan.org/vlc/index.html) older than 3.0 are not able to properly play OPUS audio that is stored into a Matroska/WEBM container, which is the format used by this demo to store recordings when using the VP8 video codec.

If you use an older Linux distro that comes with VLC 2.x, then you will have to look into how to install a more up to date version of VLC, or just use a different media player.

For example, in Ubuntu systems, you can run the latest `snap`-based VLC version, with these commands:

```sh
sudo apt-get update
sudo apt-get install snapd
sudo snap install vlc
export PATH="/snap/bin:$PATH"
vlc
```
