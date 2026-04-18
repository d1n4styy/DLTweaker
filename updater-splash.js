'use strict';

const path = require('path');
const fs = require('fs').promises;
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { sleep } = require('./electron-utils');
const { applyQuickPatch } = require('./quick-patch');
const startupTrace = require('./startup-trace');

/** @type {typeof import('./electron-app-state')} */
let state;
/** @type {() => void} */
let createMainWindowFn;
/** @type {() => void} */
let notifyUpdatesFlowResumedMainFn;

const GH_UPDATES_OWNER = 'd1n4styy';
const GH_UPDATES_REPO = 'DLTweaker';
const GENERIC_UPDATE_FEED_BASE = 'https://github.com/d1n4styy/DLTweaker/releases/latest/download/';

const SPLASH_CONTENT_WIDTH = 220;
const SPLASH_CONTENT_HEIGHT = 320;

function sanitizeNetworkErrorMessage(raw) {
  const s = raw == null ? '' : String(raw);
  const head = s.slice(0, 6000).toLowerCase();
  if (head.includes('<!doctype') || head.includes('<html') || head.includes('</html>')) {
    return 'Сервер вернул HTML вместо данных (прокси, блокировка или неверный URL канала обновлений).';
  }
  return s.length > 420 ? `${s.slice(0, 420)}…` : s;
}

function patchAutoUpdaterHttpTimeouts() {
  const ex = autoUpdater.httpExecutor;
  if (!ex || ex.__dltwHttpTimeoutPatched) return;
  ex.__dltwHttpTimeoutPatched = true;
  const CHECK_MS = 14_000;
  const DOWNLOAD_MS = 480_000;

  function pickTimeout(p) {
    const pathStr = String(p || '').toLowerCase();
    return /\.(exe|zip|dmg|7z|msi|blockmap)(\?|;|#|$)/i.test(pathStr) ? DOWNLOAD_MS : CHECK_MS;
  }

  if (typeof ex.request === 'function') {
    const origRequest = ex.request.bind(ex);
    ex.request = (options, cancellationToken, data) => {
      if (!options || typeof options !== 'object' || options.timeout != null) {
        return origRequest(options, cancellationToken, data);
      }
      return origRequest({ ...options, timeout: pickTimeout(options.path) }, cancellationToken, data);
    };
  }
  if (typeof ex.doDownload === 'function') {
    const origDl = ex.doDownload.bind(ex);
    ex.doDownload = (requestOptions, options, redirectCount) => {
      let ro = requestOptions;
      if (ro && typeof ro === 'object' && ro.timeout == null) {
        ro = { ...ro, timeout: pickTimeout(ro.path) };
      }
      return origDl(ro, options, redirectCount);
    };
  }
}

function clearUpdaterListeners() {
  for (const [evt, fn] of state.updaterListeners) {
    autoUpdater.removeListener(evt, fn);
  }
  state.updaterListeners = [];
}

function addUpdaterListener(evt, fn) {
  autoUpdater.on(evt, fn);
  state.updaterListeners.push([evt, fn]);
}

async function prepareUpdaterSession() {
  if (app.isPackaged) return true;
  if ((process.env.DLTWEAKER_UPDATE_URL || '').trim()) {
    autoUpdater.forceDevUpdateConfig = true;
    return true;
  }
  try {
    await fs.access(path.join(__dirname, 'dev-app-update.yml'));
    autoUpdater.forceDevUpdateConfig = true;
    return true;
  } catch {
    return false;
  }
}

function configureAutoUpdaterFeed() {
  const raw = (process.env.DLTWEAKER_UPDATE_URL || '').trim();
  if (raw) {
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: raw.replace(/\/?$/, '/') });
    } catch {
      /* keep embedded app-update.yml from electron-builder */
    }
    return;
  }
  if (!app.isPackaged) return;
  try {
    if ((process.env.DLTWEAKER_USE_GITHUB_UPDATER || '').trim() === '1') {
      autoUpdater.setFeedURL({ provider: 'github', owner: GH_UPDATES_OWNER, repo: GH_UPDATES_REPO });
    } else {
      autoUpdater.setFeedURL({ provider: 'generic', url: GENERIC_UPDATE_FEED_BASE });
    }
  } catch {
    /* keep embedded app-update.yml from electron-builder */
  }
}

async function checkForUpdatesWithFeedFallback() {
  const customUrl = (process.env.DLTWEAKER_UPDATE_URL || '').trim();
  if (customUrl || !app.isPackaged) {
    return await autoUpdater.checkForUpdates();
  }
  const genericOnly = (process.env.DLTWEAKER_USE_GENERIC_UPDATER || '').trim() === '1';
  const githubFirst = (process.env.DLTWEAKER_USE_GITHUB_UPDATER || '').trim() === '1';
  const githubFallback = (process.env.DLTWEAKER_USE_GITHUB_FALLBACK || '').trim() === '1';

  /** @type {Array<'generic' | 'github'>} */
  let feedOrder;
  if (genericOnly) {
    feedOrder = ['generic'];
  } else if (githubFirst) {
    feedOrder = ['github', 'generic'];
  } else if (githubFallback) {
    feedOrder = ['generic', 'github'];
  } else {
    feedOrder = ['generic'];
  }

  let lastErr;
  for (const kind of feedOrder) {
    try {
      if (kind === 'generic') {
        autoUpdater.setFeedURL({ provider: 'generic', url: GENERIC_UPDATE_FEED_BASE });
      } else {
        autoUpdater.setFeedURL({ provider: 'github', owner: GH_UPDATES_OWNER, repo: GH_UPDATES_REPO });
      }
      applyAutoUpdaterDefaults();
      return await autoUpdater.checkForUpdates();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function applyAutoUpdaterDefaults() {
  autoUpdater.autoDownload = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.disableWebInstaller = true;
  try {
    const v = app.getVersion();
    autoUpdater.requestHeaders = {
      ...autoUpdater.requestHeaders,
      'User-Agent': `DeadlockTweaker/${v} (${process.platform})`,
      Accept: '*/*',
    };
  } catch {
    /* ignore */
  }
  patchAutoUpdaterHttpTimeouts();
}

function bringSplashToFront() {
  if (!state.splashWin || state.splashWin.isDestroyed()) return;
  try {
    if (!state.splashWin.isVisible()) state.splashWin.show();
    state.splashWin.setAlwaysOnTop(true);
    state.splashWin.moveTop();
    state.splashWin.focus();
  } catch {
    /* ignore */
  }
}

function sendSplashStatus(payload) {
  bringSplashToFront();
  if (state.splashWin && !state.splashWin.isDestroyed()) {
    state.splashWin.webContents.send('splash-status', payload);
  }
}

function closeSplashProgrammatically() {
  if (!state.splashWin || state.splashWin.isDestroyed()) return;
  state.splashProgrammaticClose = true;
  try {
    state.splashWin.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    state.splashProgrammaticClose = false;
  }, 0);
}

function createSplashWindow() {
  /** Нельзя сначала уничтожать старый сплэш: между destroy и new будет 0 окон → `window-all-closed` → `app.quit()`. */
  const prevSplash = state.splashWin && !state.splashWin.isDestroyed() ? state.splashWin : null;

  const win = new BrowserWindow({
    useContentSize: true,
    width: SPLASH_CONTENT_WIDTH,
    height: SPLASH_CONTENT_HEIGHT,
    minWidth: SPLASH_CONTENT_WIDTH,
    minHeight: SPLASH_CONTENT_HEIGHT,
    maxWidth: SPLASH_CONTENT_WIDTH,
    maxHeight: SPLASH_CONTENT_HEIGHT,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: true,
    center: true,
    alwaysOnTop: true,
    icon: path.join(__dirname, 'assets', 'logo.png'),
    backgroundColor: '#0a0a0a',
    title: 'Запуск',
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  state.splashWin = win;
  const splashRef = win;
  startupTrace.trace('splash: BrowserWindow created (show=true)');

  win.on('closed', () => {
    if (state.splashWin === splashRef) state.splashWin = null;
  });
  win.on('close', () => {
    if (state.splashProgrammaticClose) return;
    if (state.splashWin !== splashRef) return;

    const noMain = !state.mainWin || state.mainWin.isDestroyed();
    if (noMain && state.splashBootstrapActive) {
      startupTrace.trace(
        'splash: close during bootstrap (краш рендерера / сбой окна) — открываем главное окно вместо выхода',
      );
      setImmediate(() => {
        try {
          createMainWindowFn();
        } catch (e) {
          startupTrace.traceErr('splash: createMainWindow after splash failure', e);
        } finally {
          state.splashBootstrapActive = false;
        }
      });
      return;
    }

    state.splashUserAborted = true;
    clearUpdaterListeners();
    if (noMain) {
      setImmediate(() => {
        try {
          app.quit();
        } catch {
          /* ignore */
        }
      });
      return;
    }
    if (!state.mainWin.isVisible()) {
      try {
        state.mainWin.destroy();
      } catch {
        /* ignore */
      }
      setImmediate(() => {
        try {
          if (BrowserWindow.getAllWindows().length === 0) app.quit();
        } catch {
          /* ignore */
        }
      });
    }
  });

  let splashShowTimer = null;
  const cancelSplashShowTimer = () => {
    if (splashShowTimer) {
      clearTimeout(splashShowTimer);
      splashShowTimer = null;
    }
  };

  const tryShowSplash = () => {
    if (win.isDestroyed()) return;
    try {
      win.setContentSize(SPLASH_CONTENT_WIDTH, SPLASH_CONTENT_HEIGHT);
      win.center();
    } catch {
      /* ignore */
    }
    try {
      win.show();
    } catch {
      /* ignore */
    }
  };

  splashShowTimer = setTimeout(() => {
    splashShowTimer = null;
    tryShowSplash();
  }, 2500);

  win.once('ready-to-show', () => {
    cancelSplashShowTimer();
    tryShowSplash();
  });

  win.webContents.once('did-finish-load', () => {
    cancelSplashShowTimer();
    tryShowSplash();
  });

  win.webContents.once('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    cancelSplashShowTimer();
    tryShowSplash();
  });

  win.loadFile('splash.html');

  if (prevSplash) {
    state.splashProgrammaticClose = true;
    try {
      prevSplash.destroy();
    } catch {
      try {
        prevSplash.close();
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => {
      state.splashProgrammaticClose = false;
    }, 0);
  }
}

async function waitForSplashLoad() {
  if (!state.splashWin || state.splashWin.isDestroyed()) return;
  const wc = state.splashWin.webContents;

  const splashLoaded = () => {
    try {
      const u = (wc.getURL() || '').toLowerCase();
      return !wc.isLoading() && (u.includes('splash.html') || u.includes('splash%2ehtml'));
    } catch {
      return false;
    }
  };

  if (!splashLoaded()) {
    await Promise.race([
      new Promise((resolve) => {
        const cleanup = () => {
          wc.removeListener('did-finish-load', onOk);
          wc.removeListener('did-fail-load', onFail);
        };
        const onOk = () => {
          cleanup();
          resolve();
        };
        const onFail = () => {
          cleanup();
          resolve();
        };
        wc.once('did-finish-load', onOk);
        wc.once('did-fail-load', onFail);
      }),
      new Promise((resolve) => setTimeout(resolve, 25_000)),
    ]);
  }
}

async function waitForSplashIpcReady() {
  if (!state.splashWin || state.splashWin.isDestroyed()) return;
  const wc = state.splashWin.webContents;
  for (let i = 0; i < 80; i += 1) {
    try {
      const ready = await wc.executeJavaScript(
        'Boolean(window.splashAPI && typeof window.splashAPI.onStatus === "function")',
        true,
      );
      if (ready) return;
    } catch {
      /* окно ещё не готово */
    }
    await sleep(25);
  }
}

async function drainSplashQuickPatch(fastResume, awaitFull) {
  const p = state.splashQuickPatchPromise;
  if (!p) return;
  if (awaitFull) {
    try {
      await Promise.race([p.catch(() => null), sleep(45_000)]);
    } catch {
      /* ignore */
    }
    state.splashQuickPatchPromise = null;
    return;
  }
  const capMs = fastResume ? 8000 : 16_000;
  const outcome = await Promise.race([
    p.then(() => 'qp').catch(() => 'qp'),
    sleep(capMs).then(() => 'timeout'),
  ]);
  if (outcome === 'qp') {
    state.splashQuickPatchPromise = null;
  }
}

async function openMainAfterSplash(fastResume = false) {
  try {
    state.settingsSplashUpdateBusy = false;
    if (state.splashUserAborted) {
      state.splashBootstrapActive = false;
      return;
    }
    if (state.mainWin && !state.mainWin.isDestroyed()) {
      await drainSplashQuickPatch(fastResume, true);
      if (state.splashWin && !state.splashWin.isDestroyed()) closeSplashProgrammatically();
      try {
        state.mainWin.show();
        state.mainWin.focus();
      } catch {
        /* ignore */
      }
      notifyUpdatesFlowResumedMainFn();
      state.splashBootstrapActive = false;
      return;
    }
    sendSplashStatus({ phase: 'launching', message: 'Запуск приложения…' });
    await sleep(fastResume ? 120 : 280);
    if (state.splashUserAborted) {
      state.splashBootstrapActive = false;
      return;
    }
    await drainSplashQuickPatch(fastResume, false);
    if (state.splashUserAborted) {
      state.splashBootstrapActive = false;
      return;
    }
    startupTrace.trace('splash: calling createMainWindow');
    createMainWindowFn();
    state.splashBootstrapActive = false;
  } catch (err) {
    state.splashBootstrapActive = false;
    startupTrace.traceErr('openMainAfterSplash', err);
    const msg = err && err.message ? String(err.message) : String(err);
    try {
      dialog.showErrorBox('Deadlock Tweaker', `Не удалось открыть главное окно:\n${msg}`);
    } catch {
      /* ignore */
    }
  }
}

async function runSplashUpdateFlow(opts = {}) {
  const fast = opts.fastIntro === true;
  startupTrace.trace(`splash: runSplashUpdateFlow begin (fast=${fast})`);
  clearUpdaterListeners();
  await waitForSplashLoad();
  if (state.splashUserAborted) {
    state.splashBootstrapActive = false;
    return;
  }
  if (!state.splashWin || state.splashWin.isDestroyed()) {
    void openMainAfterSplash(fast);
    return;
  }
  await waitForSplashIpcReady();
  if (state.splashUserAborted) {
    state.splashBootstrapActive = false;
    return;
  }
  if (!state.splashWin || state.splashWin.isDestroyed()) {
    void openMainAfterSplash(fast);
    return;
  }
  await sleep(fast ? 96 : 80);
  if (state.splashUserAborted) {
    state.splashBootstrapActive = false;
    return;
  }
  if (!state.splashWin || state.splashWin.isDestroyed()) {
    void openMainAfterSplash(fast);
    return;
  }
  bringSplashToFront();

  state.splashQuickPatchPromise = applyQuickPatch(app, { silent: true }).catch(() => null);

  sendSplashStatus({ phase: 'checking', message: 'Проверка обновлений…' });

  const runUpdater = await prepareUpdaterSession();
  if (!runUpdater) {
    await sleep(fast ? 0 : 50);
    await openMainAfterSplash(fast);
    return;
  }

  configureAutoUpdaterFeed();
  applyAutoUpdaterDefaults();

  let settled = false;
  let postCheckComplete = false;
  let lastUpdateDownloadTotal = 0;
  const checkPhaseTimeoutMs = fast ? 24_000 : 32_000;
  const downloadPhaseTimeoutMs = 15 * 60 * 1000;
  let flowGuard = null;

  const clearFlowGuard = () => {
    if (flowGuard) {
      clearTimeout(flowGuard);
      flowGuard = null;
    }
  };

  const armFlowGuard = (ms, message) => {
    clearFlowGuard();
    flowGuard = setTimeout(() => {
      if (settled) return;
      settled = true;
      done();
      clearUpdaterListeners();
      sendSplashStatus({ phase: 'offline', message });
      setTimeout(() => {
        void openMainAfterSplash(fast);
      }, fast ? 450 : 650);
    }, ms);
  };

  armFlowGuard(checkPhaseTimeoutMs, 'Таймаут проверки — запуск без обновления');

  const done = () => {
    clearFlowGuard();
  };

  const goMain = async () => {
    if (state.splashUserAborted) {
      state.splashBootstrapActive = false;
      return;
    }
    if (settled) return;
    settled = true;
    done();
    clearUpdaterListeners();
    await openMainAfterSplash(fast);
  };

  const onDownloaded = () => {
    if (settled) return;
    settled = true;
    done();
    clearUpdaterListeners();
    sendSplashStatus({
      phase: 'installing',
      message: 'Применение обновления…',
      installIndeterminate: true,
      percent: 100,
      downloadedTotal: lastUpdateDownloadTotal || undefined,
    });
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch {
        void openMainAfterSplash(fast);
      }
    }, 200);
  };

  addUpdaterListener('update-available', (info) => {
    armFlowGuard(downloadPhaseTimeoutMs, 'Таймаут загрузки обновления — открываем приложение');
    sendSplashStatus({
      phase: 'available',
      message: `Доступна версия ${info.version}`,
    });
  });

  addUpdaterListener('download-progress', (p) => {
    if (typeof p.total === 'number' && p.total > 0) {
      lastUpdateDownloadTotal = p.total;
    }
    sendSplashStatus({
      phase: 'downloading',
      message: `Загрузка обновления… ${Math.round(p.percent)}%`,
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });

  addUpdaterListener('update-downloaded', () => {
    onDownloaded();
  });

  addUpdaterListener('update-not-available', () => {
    if (settled) return;
    sendSplashStatus({ phase: 'uptodate', message: 'Установлена последняя версия' });
    setTimeout(() => {
      void goMain();
    }, fast ? 280 : 420);
  });

  addUpdaterListener('error', (err) => {
    if (settled || !postCheckComplete) return;
    settled = true;
    done();
    clearUpdaterListeners();
    const hint = sanitizeNetworkErrorMessage(err && err.message ? String(err.message) : '').slice(0, 220);
    sendSplashStatus({
      phase: 'offline',
      message: 'Ошибка при загрузке обновления — открываем приложение',
      detail: hint || undefined,
    });
    setTimeout(() => {
      void openMainAfterSplash(fast);
    }, fast ? 500 : 700);
  });

  try {
    if (state.splashUserAborted) {
      state.splashBootstrapActive = false;
      return;
    }
    if (!state.splashWin || state.splashWin.isDestroyed()) {
      if (!settled) {
        settled = true;
        done();
        clearUpdaterListeners();
        void openMainAfterSplash(fast);
      }
      return;
    }
    await checkForUpdatesWithFeedFallback();
  } catch (err) {
    if (!settled) {
      settled = true;
      done();
      clearUpdaterListeners();
      const hint = sanitizeNetworkErrorMessage(err && err.message ? String(err.message) : '').slice(0, 220);
      sendSplashStatus({
        phase: 'offline',
        message: 'Не удалось проверить обновления — открываем приложение',
        detail: hint || undefined,
      });
      setTimeout(() => {
        void openMainAfterSplash(fast);
      }, fast ? 450 : 650);
    }
  } finally {
    postCheckComplete = true;
  }
}

function startSplashThenMain() {
  state.splashUserAborted = false;
  state.settingsSplashUpdateBusy = false;
  state.splashBootstrapActive = true;
  startupTrace.trace('splash: startSplashThenMain');
  try {
    createSplashWindow();
  } catch (e) {
    state.splashBootstrapActive = false;
    startupTrace.traceErr('splash: createSplashWindow threw', e);
    try {
      dialog.showErrorBox('Deadlock Tweaker', `Сплэш: ${e && e.message ? String(e.message) : String(e)}`);
    } catch {
      /* ignore */
    }
    try {
      createMainWindowFn();
    } catch (e2) {
      startupTrace.traceErr('splash: createMainWindow fallback failed', e2);
    }
    return;
  }
  void runSplashUpdateFlow();
}

function focusExistingWindow() {
  if (state.mainWin && !state.mainWin.isDestroyed()) {
    if (state.mainWin.isMinimized()) state.mainWin.restore();
    state.mainWin.show();
    state.mainWin.focus();
  } else if (state.splashWin && !state.splashWin.isDestroyed()) {
    state.splashWin.show();
    state.splashWin.focus();
  }
}

async function manualUpdaterDevGate() {
  if (app.isPackaged) return null;
  const envUrl = (process.env.DLTWEAKER_UPDATE_URL || '').trim();
  let hasDevYml = false;
  try {
    await fs.access(path.join(__dirname, 'dev-app-update.yml'));
    hasDevYml = true;
  } catch {
    /* no dev feed */
  }
  if (!envUrl && !hasDevYml) {
    return {
      ok: false,
      code: 'dev',
      message:
        'Для проверки в dev задайте DLTWEAKER_UPDATE_URL или скопируйте dev-app-update.example.yml → dev-app-update.yml.',
    };
  }
  autoUpdater.forceDevUpdateConfig = true;
  return null;
}

const NO_UPDATE_CHANNEL_MSG =
  'Канал обновлений не настроен. Проверьте publish в package.json или DLTWEAKER_UPDATE_URL / dev-app-update.yml.';

function registerUpdaterIpc() {
  ipcMain.handle('updates-check-only', async () => {
    const gate = await manualUpdaterDevGate();
    if (gate) return gate;
    clearUpdaterListeners();
    configureAutoUpdaterFeed();
    applyAutoUpdaterDefaults();
    const prevAuto = autoUpdater.autoDownload;
    autoUpdater.autoDownload = false;
    try {
      const result = await checkForUpdatesWithFeedFallback();
      if (result == null) {
        return { ok: false, code: 'noconfig', message: NO_UPDATE_CHANNEL_MSG };
      }
      if (!result.isUpdateAvailable) {
        return {
          ok: true,
          code: 'uptodate',
          currentVersion: app.getVersion(),
          remoteVersion: result.updateInfo?.version,
        };
      }
      return {
        ok: true,
        code: 'available',
        currentVersion: app.getVersion(),
        version: result.updateInfo.version,
      };
    } catch (err) {
      const msg = sanitizeNetworkErrorMessage(err && err.message ? String(err.message) : 'Проверка не удалась');
      return { ok: false, code: 'error', message: msg };
    } finally {
      autoUpdater.autoDownload = prevAuto;
    }
  });

  ipcMain.handle('updates-download-via-splash', async () => {
    const gate = await manualUpdaterDevGate();
    if (gate) return gate;
    if (!app.isPackaged) {
      return {
        ok: false,
        code: 'dev',
        message: 'В режиме разработки используйте dev-app-update.yml или кнопку скачивания в окне.',
      };
    }
    if (!state.mainWin || state.mainWin.isDestroyed()) {
      return { ok: false, code: 'error', message: 'Нет главного окна' };
    }
    if (state.settingsSplashUpdateBusy) {
      return { ok: false, code: 'busy', message: 'Обновление уже запущено' };
    }
    state.settingsSplashUpdateBusy = true;
    clearUpdaterListeners();
    try {
      state.mainWin.hide();
    } catch {
      /* ignore */
    }
    try {
      createSplashWindow();
      await waitForSplashLoad();
    } catch (e) {
      state.settingsSplashUpdateBusy = false;
      try {
        if (state.mainWin && !state.mainWin.isDestroyed()) state.mainWin.show();
      } catch {
        /* ignore */
      }
      const msg = e && e.message ? String(e.message) : 'Не удалось открыть окно обновления';
      return { ok: false, code: 'error', message: msg };
    }
    void runSplashUpdateFlow({ fastIntro: true });
    return { ok: true, code: 'splash' };
  });

  ipcMain.handle('updates-download-install', async (event) => {
    const gate = await manualUpdaterDevGate();
    if (gate) return gate;
    clearUpdaterListeners();
    configureAutoUpdaterFeed();
    applyAutoUpdaterDefaults();

    const win = BrowserWindow.fromWebContents(event.sender);
    const parent = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
    const prevAuto = autoUpdater.autoDownload;
    autoUpdater.autoDownload = false;

    const forwardProgress = (p) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('settings-update-download-progress', {
          percent: p.percent,
          transferred: p.transferred,
          total: p.total,
        });
      }
    };
    autoUpdater.on('download-progress', forwardProgress);

    try {
      const result = await checkForUpdatesWithFeedFallback();
      if (result == null) {
        return { ok: false, code: 'noconfig', message: NO_UPDATE_CHANNEL_MSG };
      }
      if (!result.isUpdateAvailable) {
        return {
          ok: true,
          code: 'uptodate',
          currentVersion: app.getVersion(),
          remoteVersion: result.updateInfo?.version,
        };
      }
      await autoUpdater.downloadUpdate();

      const choice = await dialog.showMessageBox(parent || undefined, {
        type: 'info',
        buttons: ['Перезапустить сейчас', 'Позже'],
        defaultId: 0,
        cancelId: 1,
        title: 'Обновление загружено',
        message: `Готова версия ${result.updateInfo.version}. Перезапустить приложение для установки?`,
      });
      if (choice.response === 0) {
        setImmediate(() => {
          try {
            autoUpdater.quitAndInstall(true, true);
          } catch {
            /* ignore */
          }
        });
        return { ok: true, code: 'restarting', version: result.updateInfo.version };
      }
      return {
        ok: true,
        code: 'downloaded',
        version: result.updateInfo.version,
        message: 'Обновление скачано и установится при выходе из приложения.',
      };
    } catch (err) {
      const msg = sanitizeNetworkErrorMessage(err && err.message ? String(err.message) : 'Загрузка не удалась');
      return { ok: false, code: 'error', message: msg };
    } finally {
      autoUpdater.removeListener('download-progress', forwardProgress);
      autoUpdater.autoDownload = prevAuto;
    }
  });
}

/**
 * @param {{
 *   state: typeof import('./electron-app-state');
 *   createMainWindow: () => void;
 *   notifyUpdatesFlowResumedMain: () => void;
 * }} opts
 */
function init(opts) {
  state = opts.state;
  createMainWindowFn = opts.createMainWindow;
  notifyUpdatesFlowResumedMainFn = opts.notifyUpdatesFlowResumedMain;
}

function getMainWindowSplashHelpers() {
  return {
    bringSplashToFront,
    closeSplashProgrammatically,
  };
}

module.exports = {
  init,
  sanitizeNetworkErrorMessage,
  startSplashThenMain,
  focusExistingWindow,
  registerUpdaterIpc,
  getMainWindowSplashHelpers,
  /** Для `main.js`: ожидание сплэша при сценарии из настроек (ошибка до `runSplashUpdateFlow`). */
  waitForSplashLoad,
};
