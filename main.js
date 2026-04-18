const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const { autoUpdater } = require('electron-updater');

const execFileAsync = promisify(execFile);

const PROFILES_FILE = 'profiles.json';

let splashWin = null;
let mainWin = null;
/** @type {Array<[string, (...args: any[]) => void]>} */
let updaterListeners = [];

function profilesFilePath() {
  return path.join(app.getPath('userData'), PROFILES_FILE);
}

function sendSplashStatus(payload) {
  if (splashWin && !splashWin.isDestroyed()) {
    splashWin.webContents.send('splash-status', payload);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** NSIS passes `--updated` when launching the app after an update (see electron-builder `StartApp` macro). */
function isRelaunchAfterNsisUpdate() {
  return process.argv.some((a) => a === '--updated' || /^--updated=/i.test(a));
}

async function windowsImageRunning(exeName) {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH'], {
      windowsHide: true,
      timeout: 8000,
      encoding: 'utf8',
    });
    const t = (stdout || '').trim();
    if (!t || /^INFO:/im.test(t)) return false;
    return t.toLowerCase().includes(exeName.toLowerCase());
  } catch {
    return false;
  }
}

async function getDeadlockRunningStatus() {
  if (process.platform !== 'win32') {
    return { running: false, image: null };
  }
  const candidates = ['deadlock.exe', 'project8.exe'];
  for (const image of candidates) {
    if (await windowsImageRunning(image)) {
      return { running: true, image };
    }
  }
  return { running: false, image: null };
}

function clearUpdaterListeners() {
  for (const [evt, fn] of updaterListeners) {
    autoUpdater.removeListener(evt, fn);
  }
  updaterListeners = [];
}

function addUpdaterListener(evt, fn) {
  autoUpdater.on(evt, fn);
  updaterListeners.push([evt, fn]);
}

/** In dev: only run updater when DLTWEAKER_UPDATE_URL or dev-app-update.yml exists (see dev-app-update.example.yml). */
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

/**
 * Stable update feed: GitHub "latest/download" (generic) avoids electron-updater's GitHub
 * provider quirks (ATOM + /releases/latest JSON under Electron).
 */
const DEFAULT_UPDATE_FEED_BASE = 'https://github.com/d1n4styy/DLTweaker/releases/latest/download/';

/** Optional override: HTTPS base with `latest.yml` (generic). Otherwise packaged builds use DEFAULT_UPDATE_FEED_BASE. */
function configureAutoUpdaterFeed() {
  const raw = (process.env.DLTWEAKER_UPDATE_URL || '').trim();
  const url = raw ? raw.replace(/\/?$/, '/') : app.isPackaged ? DEFAULT_UPDATE_FEED_BASE : '';
  if (!url) return;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url });
  } catch {
    /* keep embedded app-update.yml from electron-builder */
  }
}

function applyAutoUpdaterDefaults() {
  autoUpdater.autoDownload = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableDifferentialDownload = false;
}

function createSplashWindow() {
  splashWin = new BrowserWindow({
    width: 440,
    height: 340,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    alwaysOnTop: true,
    icon: path.join(__dirname, 'assets', 'logo.png'),
    backgroundColor: '#0a0a0a',
    title: 'Deadlock Tweaker',
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWin.on('closed', () => {
    splashWin = null;
  });
  splashWin.once('ready-to-show', () => splashWin.show());
  splashWin.loadFile('splash.html');
}

function createMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    if (splashWin && !splashWin.isDestroyed()) splashWin.close();
    return;
  }
  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    frame: false,
    icon: path.join(__dirname, 'assets', 'logo.png'),
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWin.once('ready-to-show', () => {
    mainWin.show();
    if (splashWin && !splashWin.isDestroyed()) {
      splashWin.close();
    }
  });
  mainWin.loadFile('index.html');
  mainWin.on('closed', () => {
    mainWin = null;
  });
}

async function waitForSplashLoad() {
  return new Promise((resolve) => {
    if (!splashWin || splashWin.isDestroyed()) {
      resolve();
      return;
    }
    if (!splashWin.webContents.isLoading()) {
      resolve();
      return;
    }
    splashWin.webContents.once('did-finish-load', resolve);
  });
}

async function openMainAfterSplash() {
  if (mainWin && !mainWin.isDestroyed()) {
    if (splashWin && !splashWin.isDestroyed()) splashWin.close();
    return;
  }
  sendSplashStatus({ phase: 'launching', message: 'Запуск приложения…' });
  await sleep(380);
  createMainWindow();
}

async function runSplashUpdateFlow() {
  await waitForSplashLoad();
  await sleep(120);

  if (app.isPackaged && isRelaunchAfterNsisUpdate()) {
    sendSplashStatus({
      phase: 'updatedone',
      message: 'Обновление завершено',
      percent: 100,
    });
    await sleep(1850);
    await openMainAfterSplash();
    return;
  }

  sendSplashStatus({ phase: 'checking', message: 'Проверка обновлений…' });

  const runUpdater = await prepareUpdaterSession();
  if (!runUpdater) {
    await sleep(120);
    await openMainAfterSplash();
    return;
  }

  configureAutoUpdaterFeed();
  applyAutoUpdaterDefaults();

  let settled = false;
  let lastUpdateDownloadTotal = 0;
  let flowGuard = setTimeout(() => {
    if (settled) return;
    settled = true;
    done();
    clearUpdaterListeners();
    sendSplashStatus({ phase: 'offline', message: 'Таймаут проверки — запуск без обновления' });
    setTimeout(() => {
      void openMainAfterSplash();
    }, 800);
  }, 32000);

  const done = () => {
    if (flowGuard) {
      clearTimeout(flowGuard);
      flowGuard = null;
    }
  };

  const goMain = async () => {
    if (settled) return;
    settled = true;
    done();
    clearUpdaterListeners();
    await openMainAfterSplash();
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
        void openMainAfterSplash();
      }
    }, 1600);
  };

  addUpdaterListener('update-available', (info) => {
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
    sendSplashStatus({ phase: 'uptodate', message: 'У вас установлена последняя версия' });
    setTimeout(() => {
      void goMain();
    }, 550);
  });

  addUpdaterListener('error', () => {
    if (settled) return;
    settled = true;
    done();
    clearUpdaterListeners();
    sendSplashStatus({ phase: 'offline', message: 'Обновления недоступны — открываем приложение' });
    setTimeout(() => {
      void openMainAfterSplash();
    }, 850);
  });

  try {
    await autoUpdater.checkForUpdates();
  } catch {
    if (!settled) {
      settled = true;
      done();
      clearUpdaterListeners();
      sendSplashStatus({ phase: 'offline', message: 'Не удалось проверить обновления' });
      setTimeout(() => {
        void openMainAfterSplash();
      }, 800);
    }
  }
}

function startSplashThenMain() {
  createSplashWindow();
  void runSplashUpdateFlow();
}

function focusExistingWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  } else if (splashWin && !splashWin.isDestroyed()) {
    splashWin.show();
    splashWin.focus();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusExistingWindow();
  });

  app.whenReady().then(() => {
    startSplashThenMain();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      startSplashThenMain();
    } else {
      focusExistingWindow();
    }
  });
}

ipcMain.on('window-minimize', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize();
});

ipcMain.on('window-maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});

ipcMain.on('window-close', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});

ipcMain.handle('window-is-maximized', (e) => {
  return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false;
});

ipcMain.handle('profiles-load', async () => {
  try {
    const raw = await fs.readFile(profilesFilePath(), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
});

ipcMain.handle('profiles-save', async (_e, data) => {
  await fs.writeFile(profilesFilePath(), JSON.stringify(data, null, 2), 'utf8');
  return true;
});

ipcMain.handle('game-process-status', async () => getDeadlockRunningStatus());

ipcMain.handle('app-get-version', () => app.getVersion());

ipcMain.handle('updates-check-manual', async (event) => {
  if (!app.isPackaged) {
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
  }
  configureAutoUpdaterFeed();
  applyAutoUpdaterDefaults();

  const win = BrowserWindow.fromWebContents(event.sender);
  const parent = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();

  try {
    const result = await autoUpdater.checkForUpdates();
    if (result == null) {
      return {
        ok: false,
        code: 'noconfig',
        message:
          'Канал обновлений не настроен. Проверьте publish в package.json или DLTWEAKER_UPDATE_URL / dev-app-update.yml.',
      };
    }
    if (!result.isUpdateAvailable) {
      return {
        ok: true,
        code: 'uptodate',
        currentVersion: app.getVersion(),
        remoteVersion: result.updateInfo?.version,
      };
    }
    if (result.downloadPromise) {
      await result.downloadPromise;
    }
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
    const msg = err && err.message ? String(err.message) : 'Проверка не удалась';
    return { ok: false, code: 'error', message: msg };
  }
});
