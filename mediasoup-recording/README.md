# mediasoup demo - RTP recording

In this example, a browser's webcam media is transmitted to [mediasoup](https://mediasoup.org/) using WebRTC ([WebRtcTransport](https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransport)); it is then served as a plain RTP stream ([PlainTransport](https://mediasoup.org/documentation/v3/mediasoup/api/#PlainTransport)) to be received and recorded by an external process.

**The media is not re-encoded at any moment**. This is an important detail, because you want recording to take as little resources as possible. For that, the FFmpeg and GStreamer commands are carefully written to make sure that the media packets are received via RTP and get stored as-is to the output recording file.



## Setup

mediasoup applications are written for [Node.js](https://nodejs.org/), so you need to have it installed. Follow the [installation instructions](https://github.com/nodesource/distributions/blob/master/README.md) provided by NodeSource to install Node.js from an official repository; or just grab it from the official [downloads page](https://nodejs.org/en/download/).

You can choose between three recording programs:

- [GStreamer](https://gstreamer.freedesktop.org/).
- [FFmpeg](https://ffmpeg.org/). See [Recording with FFmpeg](#recording-with-ffmpeg).
- An external process.

Finally, read some [important notes](#important-notes) about recording and playback.



### Installing GStreamer

In Debian/Ubuntu systems, run the following command in a terminal:

```sh
sudo apt-get update && sudo apt-get install --yes \
    gstreamer1.0-plugins-{good,bad,ugly} \
    gstreamer1.0-{libav,tools}
```



### Installing FFmpeg

This demo uses [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static) to install a static FFmpeg binary appropriate for your platform (Linux, Windows, Mac) as part of the `npm install` command. So in principle you don't need to worry about installing FFmpeg by yourself.



## Configure

You can choose between using **VP8** or **H.264** for the video encoding, which are the two standard codecs typically used for WebRTC. For this, select the desired codec before starting the WebRTC call with the browser.

When VP8 is enabled, the recording output file format will be **WEBM**. Similarly, H.264 will use **MP4** as recording file format.

**WARNING**: Right now, recording OPUS audio into MP4 container is not working with FFmpeg, so if you enable H.264 and choose the FFmpeg recorder, then resulting MP4 files won't have working audio. Read below for more information about recording to MP4 format.



## Run

Run these commands:

```sh
npm install

npm start
```

Then wait for a message such as `Web server is listening on https://localhost:8080`, and direct your browser to that URL.



## Important notes

### Recording to MP4

MP4 is not a good format to store live recordings, because it relies on waiting until the whole recording finishes, to then save all video metadata at the end of the file. This is obviously a weak decision: it will render corrupted files if the recording process crashes or is interrupted, because in such situations the metadata couldn't be written properly.

As a sort of workaround, the MP4 specs include an alternative mode called "*MP4 Fast-Start*", which does some tricks within the container format and stores metadata at the beginning. We use MP4 Fast-Start in this example, as an attempt to generate the most reliable possible files. But the really best choice would be to never use MP4 when recording a live stream.

Related article: [Optimizing MP4 Video for Fast Streaming](https://rigor.com/blog/optimizing-mp4-video-for-fast-streaming) ([archive](https://web.archive.org/web/20200218090335/https://rigor.com/blog/optimizing-mp4-video-for-fast-streaming)).



### Recording with FFmpeg

**FFmpeg cannot record OPUS audio in MP4**.

Browsers use OPUS audio for WebRTC communications, but in FFmpeg the support for OPUS audio in MP4 containers doesn't work, even in latest versions.

This is a known issue, due to a bug with the FFmpeg OPUS metadata handling, which was reported and is being tracked here:

- [mp4 opus invalid extradata size (missing header)](http://ffmpeg.org/pipermail/ffmpeg-user/2019-September/045274.html)

We are waiting for a fix. Meanwhile, if you choose FFmpeg as the recording tool, make sure that the selected container format is WEBM, or that the stream doesn't contain audio.



### Playing back with VLC

**VLC >= 3.0 is required**.

Versions of [VLC](https://www.videolan.org/vlc/index.html) older than 3.0 are not able to properly play OPUS audio that is stored inside a Matroska/WEBM container, which is the format used by this demo to store recordings when using the VP8 video codec.

If you use an older Linux distro that comes with VLC 2.x, then you will have to look into how to install a more up to date version of VLC, or just use a different media player.

For example, in Ubuntu systems you can run the latest *Snap* VLC with these commands:

```sh
sudo apt-get update && sudo apt-get install --yes snapd
sudo snap install vlc
export PATH="/snap/bin:$PATH"
vlc
```



### RTCP Feedback support

**FFmpeg** does not support "*RTP and RTCP multiplexing*" (`rtcp-mux` in SDP files): after a cursory search, no mention of the SDP attribute `a=rtcp-mux` was found in the FFmpeg's source code, so it is safe to assume that this feature is not offered.

**GStreamer** `sdpdemux` element has these characteristics that must be taken into account when writing an RTP-based pipeline:

- It doesn't support the SDP attribute `a=rtcp-mux`, so we need to use explicit RTCP port numbers.
- It only supports using RTP+1 for the RTCP port number (source code: [gstsdpdemux.c#L428](https://gitlab.freedesktop.org/gstreamer/gst-plugins-bad/blob/1.16/gst/sdp/gstsdpdemux.c#L428)).
- It uses the same port to send and receive ("Symmetric RTP") (source code: [gstsdpdemux.c#L861](https://gitlab.freedesktop.org/gstreamer/gst-plugins-bad/blob/1.16/gst/sdp/gstsdpdemux.c#L861)).
- However, it doesn't have any mechanism to be given the remote RTCP port or auto-discover it, so it is unable to know where its own RTCP packets should be sent (source code: [gstsdpdemux.c#L844](https://gitlab.freedesktop.org/gstreamer/gst-plugins-bad/blob/1.16/gst/sdp/gstsdpdemux.c#L844)).

Due to the last point, the GStreamer `sdpdemux` receiver is not able to send RTCP feedback to the sender (mediasoup), thus there won't be any RTCP Feedback mechanisms in place, such as retransmission requests (**NACK**) or keyframe requests (**PLI**). This might change in the future, if the GStreamer implementation improves.
