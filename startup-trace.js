'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function traceFile() {
  return path.join(os.tmpdir(), 'dltweaker-startup.log');
}

function trace(msg) {
  try {
    const line = `${new Date().toISOString()} ${msg}\n`;
    fs.appendFileSync(traceFile(), line, 'utf8');
  } catch {
    /* ignore */
  }
}

function traceErr(msg, err) {
  const extra = err && err.stack ? err.stack : String(err);
  trace(`${msg}: ${extra}`);
}

module.exports = { trace, traceErr, traceFile };
