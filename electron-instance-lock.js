'use strict';

/**
 * Single-instance: при повторном запуске завершаем предыдущий главный процесс (PID из файла) и снова запрашиваем lock.
 * PID пишется в %TEMP% после успешного lock и whenReady.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const startupTrace = require('./startup-trace');

const PID_FILE = path.join(os.tmpdir(), 'dltweaker-main-instance.pid');

function sleepSync(ms) {
  if (ms <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `Start-Sleep -Milliseconds ${Math.min(ms, 60000)}`],
        { stdio: 'ignore', windowsHide: true, timeout: ms + 3000 },
      );
      return;
    } catch {
      /* fall through */
    }
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy-wait fallback */
  }
}

function readPreviousPid() {
  try {
    const s = fs.readFileSync(PID_FILE, 'utf8').trim();
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function terminatePid(pid) {
  if (pid == null || pid === process.pid) return false;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 20000,
      });
      startupTrace.trace(`instance-lock: taskkill /PID ${pid}`);
      return true;
    } catch (e) {
      startupTrace.traceErr(`instance-lock: taskkill ${pid} (уже завершён?)`, e);
      return false;
    }
  }
  try {
    process.kill(pid, 'SIGTERM');
    startupTrace.trace(`instance-lock: SIGTERM ${pid}`);
    return true;
  } catch (e) {
    startupTrace.traceErr(`instance-lock: kill ${pid}`, e);
    return false;
  }
}

/**
 * @param {import('electron').App} app
 * @returns {boolean}
 */
function requestSingleInstanceWithReplace(app) {
  if (app.requestSingleInstanceLock()) {
    return true;
  }
  startupTrace.trace('instance-lock: lock занят — пробуем завершить предыдущий PID из файла');

  const prev = readPreviousPid();
  if (prev != null && prev !== process.pid) {
    terminatePid(prev);
    for (let i = 0; i < 20; i += 1) {
      sleepSync(200);
      if (app.requestSingleInstanceLock()) {
        startupTrace.trace('instance-lock: lock получен после завершения предыдущего процесса');
        return true;
      }
    }
  }

  startupTrace.trace('instance-lock: lock так и не получен');
  return false;
}

function writeMainPidFile() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
    startupTrace.trace(`instance-lock: записан PID ${process.pid}`);
  } catch (e) {
    startupTrace.traceErr('instance-lock: запись PID', e);
  }
}

function clearMainPidFile() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
}

module.exports = {
  requestSingleInstanceWithReplace,
  writeMainPidFile,
  clearMainPidFile,
  /** для release-notes / отладки */
  pidFilePath: () => PID_FILE,
};
