#!/usr/bin/env node

"use strict";

const Https = require("https");
const Fs = require("fs");
const Util = require("util");

const Express = require("express");
const expressWs = require('express-ws');

const mediaSoupRecording = require('.')

const CONFIG = require("./config");


// Log whole objects instead of giving up after two levels of nesting
Util.inspect.defaultOptions.depth = null;


// ----------------------------------------------------------------------------

// HTTPS server
// ============

const app = Express()

const https = Https.createServer(
{
  cert: Fs.readFileSync(CONFIG.https.cert),
  key: Fs.readFileSync(CONFIG.https.certKey),
}, app);

expressWs(app, https, {
  pingTimeout: CONFIG.https.wsPingTimeout,
  pingInterval: CONFIG.https.wsPingInterval,
});


app.use("/", Express.static(__dirname));

https.on("listening", () => {
  console.log(
    `Web server is listening on https://localhost:${CONFIG.https.port}`
  );
});
https.on("error", (err) => {
  console.error("HTTPS error:", err.message);
});
https.on("tlsClientError", (err) => {
  if (err.message.includes("alert number 46")) {
    // Ignore: this is the client browser rejecting our self-signed certificate
  } else {
    console.error("TLS error:", err);
  }
});
https.listen(CONFIG.https.port);


// ----------------------------------------------------------------------------

// WebSocket server
// ================

app.ws(CONFIG.https.wsPath, mediaSoupRecording(CONFIG));
