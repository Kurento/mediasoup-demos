"use strict";

const Debug = require("debug");

const APP_NAME = "demo";
const LOG_LEVELS = { error: 0, warn: 1, info: 2, log: 3, trace: 4 };
let logLevel = LOG_LEVELS.info; // Default log level if none is specified.

// log is a Function which by default calls the info() debugger.
const log = function (...args) {
  log.info(...args);
};

for (const name of Object.keys(LOG_LEVELS)) {
  const namespace = APP_NAME + ":" + name;
  const _debugger = Debug(namespace);

  if (_debugger.enabled) {
    logLevel = LOG_LEVELS[name]; // Highest enabled log level.
  }

  _debugger.log = (...args) => {
    if (LOG_LEVELS[name] <= logLevel) {
      Debug.log(...args);
    }
  };

  log[name] = _debugger; // Attach new method to the log Function.
}

// Enable all log levels below the highest one.
for (const name of Object.keys(LOG_LEVELS)) {
  if (LOG_LEVELS[name] <= logLevel) {
    log[name].enabled = true;
  }
}

module.exports = log;
