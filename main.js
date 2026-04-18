const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const { autoUpdater } = require('electron-updater');
const { applyQuickPatch, readOverlayCss } = require('./quick-patch');

const execFileAsync = promisify(execFile);

const PROFILES_FILE = 'profiles.json';

let splashWin = null;
let mainWin = null;
/** Сплэш не закрываем до первой отрисовки основного окна (см. createMainWindow). */
let mainWinSplashCloseScheduled = false;
/** @type {Array<[string, (...args: any[]) => void]>} */
let updaterListeners = [];

function profilesFilePath() {
  return path.join(app.getPath('userData'), PROFILES_FILE);
}

/** Пока нет главного окна — держим сплэш поверх, чтобы его не «перекрывали» и не казалось, что он пропал. */
function bringSplashToFront() {
  if (!splashWin || splashWin.isDestroyed()) return;
  try {
    if (!splashWin.isVisible()) splashWin.show();
    splashWin.setAlwaysOnTop(true);
    splashWin.moveTop();
    splashWin.focus();
  } catch {
    /* ignore */
  }
}

function sendSplashStatus(payload) {
  bringSplashToFront();
  if (splashWin && !splashWin.isDestroyed()) {
    splashWin.webContents.send('splash-status', payload);
  }
}

/**
 * Перед quitAndInstall: окно сплэша на весь workArea с тёмным фоном — меньше «вспышки» рабочего стола
 * между выходом процесса и тихим NSIS (/S). Контент splash.css по центру, по краям фон body.
 */
function stretchSplashForInstallCover() {
  if (!splashWin || splashWin.isDestroyed()) return;
  try {
    const wa = screen.getDisplayMatching(splashWin.getBounds()).workArea;
    splashWin.setResizable(true);
    splashWin.setMinimumSize(1, 1);
    /* Снять фикс 220×320 (min/max), иначе setBounds на workArea не применится */
    splashWin.setMaximumSize(16000, 16000);
    splashWin.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
    splashWin.setBackgroundColor('#0a0a0a');
    splashWin.setAlwaysOnTop(true);
    splashWin.moveTop();
    splashWin.focus();
  } catch {
    /* ignore */
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

const GH_UPDATES_OWNER = 'd1n4styy';
const GH_UPDATES_REPO = 'DLTweaker';
const GH_RELEASES_API = `https://api.github.com/repos/${GH_UPDATES_OWNER}/${GH_UPDATES_REPO}/releases?per_page=12`;

/** Optional local blurbs when GitHub `body` is empty (electron-builder often publishes without notes). */
let cachedBundledReleaseNotes = undefined;

async function getBundledReleaseNotesMap() {
  if (cachedBundledReleaseNotes !== undefined) return cachedBundledReleaseNotes;
  try {
    const raw = await fs.readFile(path.join(__dirname, 'release-notes.json'), 'utf8');
    const parsed = JSON.parse(raw);
    cachedBundledReleaseNotes = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cachedBundledReleaseNotes = {};
  }
  return cachedBundledReleaseNotes;
}

/** Generic `latest/download` — прямой `latest.yml` последнего релиза (надёжнее, чем GitHub-провайдер). */
const GENERIC_UPDATE_FEED_BASE = 'https://github.com/d1n4styy/DLTweaker/releases/latest/download/';

/**
 * Канал обновлений (сборка): по умолчанию generic (`latest.yml`); при сбое — провайдер GitHub.
 * Только generic (без второй попытки): `DLTWEAKER_USE_GENERIC_UPDATER=1`.
 * Сначала GitHub, потом generic: `DLTWEAKER_USE_GITHUB_UPDATER=1` (старое поведение).
 * Свой хост: `DLTWEAKER_UPDATE_URL` (HTTPS, `latest.yml` в корне).
 */
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

/** По умолчанию generic (`latest.yml`), затем GitHub; порядок можно поменять переменными окружения. */
async function checkForUpdatesWithFeedFallback() {
  const customUrl = (process.env.DLTWEAKER_UPDATE_URL || '').trim();
  if (customUrl || !app.isPackaged) {
    return await autoUpdater.checkForUpdates();
  }
  const genericOnly = (process.env.DLTWEAKER_USE_GENERIC_UPDATER || '').trim() === '1';
  const githubFirst = (process.env.DLTWEAKER_USE_GITHUB_UPDATER || '').trim() === '1';

  /** @type {Array<'generic' | 'github'>} */
  let feedOrder;
  if (genericOnly) {
    feedOrder = ['generic'];
  } else if (githubFirst) {
    feedOrder = ['github', 'generic'];
  } else {
    feedOrder = ['generic', 'github'];
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
  autoUpdater.disableDifferentialDownload = false;
  autoUpdater.disableWebInstaller = true;
}

/** Splash: больше высоты героя — иначе max-height:100% не даёт логотипу вырасти. */
const SPLASH_CONTENT_WIDTH = 220;
const SPLASH_CONTENT_HEIGHT = 320;

/**
 * Основное окно: фиксированный размер клиентской области (1280×820).
 * Не менять при доработках сплэша, splash.css / splash.html или превью — только осознанно под макет приложения.
 */
const MAIN_WINDOW_WIDTH = 1280;
const MAIN_WINDOW_HEIGHT = 820;
/** Windows: системная рамка и кнопки (сворачивание / размер / закрытие) — без кастомного titlebar. */
const MAIN_WIN_NATIVE_FRAME = process.platform === 'win32';

/** Минимальный размер макета; разворот — нативный maximize/unmaximize (анимация Windows). */
function setupMainWindowSizing(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setMinimumSize(MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT);
    win.setResizable(true);
    win.setMaximizable(true);
    win.setFullScreenable(true);
  } catch {
    /* ignore */
  }
}

function createSplashWindow() {
  splashWin = new BrowserWindow({
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
    show: false,
    center: true,
    alwaysOnTop: true,
    icon: path.join(__dirname, 'assets', 'logo.png'),
    backgroundColor: '#0a0a0a',
    title: 'Запуск',
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWin.on('closed', () => {
    splashWin = null;
  });
  splashWin.once('ready-to-show', () => {
    if (!splashWin || splashWin.isDestroyed()) return;
    try {
      splashWin.setContentSize(SPLASH_CONTENT_WIDTH, SPLASH_CONTENT_HEIGHT);
      splashWin.center();
    } catch {
      /* ignore */
    }
    splashWin.show();
  });
  splashWin.loadFile('splash.html');
}

function createMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    if (splashWin && !splashWin.isDestroyed()) splashWin.close();
    return;
  }
  mainWinSplashCloseScheduled = false;
  mainWin = new BrowserWindow({
    width: MAIN_WINDOW_WIDTH,
    height: MAIN_WINDOW_HEIGHT,
    minWidth: MAIN_WINDOW_WIDTH,
    minHeight: MAIN_WINDOW_HEIGHT,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    frame: MAIN_WIN_NATIVE_FRAME,
    title: 'Deadlock Tweaker',
    icon: path.join(__dirname, 'assets', 'logo.png'),
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupMainWindowSizing(mainWin);

  /* Windows + нативная рамка: кастомный .titlebar в DOM скрываем из main (не зависит от CSP/порядка renderer). */
  if (MAIN_WIN_NATIVE_FRAME) {
    mainWin.webContents.once('dom-ready', () => {
      if (!mainWin || mainWin.isDestroyed()) return;
      void mainWin.webContents.insertCSS('#titlebar{display:none!important}.main-atmosphere{top:0!important}');
    });
  }

  mainWin.once('ready-to-show', () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    try {
      mainWin.setContentSize(MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT);
      mainWin.setMinimumSize(MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT);
    } catch {
      /* ignore */
    }
    mainWin.show();
    bringSplashToFront();
  });
  mainWin.loadFile('index.html');
  mainWin.webContents.once('did-finish-load', () => {
    const w = mainWin;
    if (!mainWinSplashCloseScheduled) {
      mainWinSplashCloseScheduled = true;
      setTimeout(() => {
        if (splashWin && !splashWin.isDestroyed()) {
          splashWin.close();
        }
      }, 100);
    }
    void applyQuickPatch(app, { silent: true }).then((r) => {
      if (r && r.ok && r.code === 'applied' && w && !w.isDestroyed()) {
        w.webContents.send('quick-patch-updated');
      }
    });
  });
  mainWin.on('closed', () => {
    mainWin = null;
    mainWinSplashCloseScheduled = false;
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
  bringSplashToFront();

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
  /** After `checkForUpdates` (incl. retries) finishes — avoids treating check-time `error` as fatal (electron-updater emits before throw). */
  let postCheckComplete = false;
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
    stretchSplashForInstallCover();
    bringSplashToFront();
    /** Дать кадр на отрисовку растянутого сплэша, затем тихий NSIS (isSilent → /S) + перезапуск. */
    setTimeout(() => {
      try {
        bringSplashToFront();
        autoUpdater.quitAndInstall(true, true);
      } catch {
        void openMainAfterSplash();
      }
    }, 380);
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
    sendSplashStatus({ phase: 'uptodate', message: 'Установлена последняя версия' });
    setTimeout(() => {
      void goMain();
    }, 550);
  });

  addUpdaterListener('error', (err) => {
    if (settled || !postCheckComplete) return;
    settled = true;
    done();
    clearUpdaterListeners();
    const hint = err && err.message ? String(err.message).slice(0, 220) : '';
    sendSplashStatus({
      phase: 'offline',
      message: 'Ошибка при загрузке обновления — открываем приложение',
      detail: hint || undefined,
    });
    setTimeout(() => {
      void openMainAfterSplash();
    }, 850);
  });

  try {
    await checkForUpdatesWithFeedFallback();
  } catch (err) {
    if (!settled) {
      settled = true;
      done();
      clearUpdaterListeners();
      const hint = err && err.message ? String(err.message).slice(0, 220) : '';
      sendSplashStatus({
        phase: 'offline',
        message: 'Не удалось проверить обновления — открываем приложение',
        detail: hint || undefined,
      });
      setTimeout(() => {
        void openMainAfterSplash();
      }, 800);
    }
  } finally {
    postCheckComplete = true;
  }
}

function startSplashThenMain() {
  /** После NSIS второй запуск с --updated: без второго сплэша — сразу главное окно (меньше миганий). */
  if (app.isPackaged && isRelaunchAfterNsisUpdate()) {
    createMainWindow();
    return;
  }
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
    if (MAIN_WIN_NATIVE_FRAME) {
      try {
        Menu.setApplicationMenu(null);
      } catch {
        /* ignore */
      }
    }
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
  if (!w || w.isDestroyed()) return;
  /** Нативный maximize/unmaximize — системная анимация Windows (DWM), без ручного setBounds. */
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});

ipcMain.on('window-close', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});

ipcMain.handle('window-is-maximized', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return false;
  return w.isMaximized();
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

ipcMain.handle('quick-patch-apply', async () => applyQuickPatch(app, { silent: false }));

ipcMain.handle('quick-patch-get-css', async () => {
  const css = await readOverlayCss(app);
  return css || '';
});

ipcMain.handle('open-external-url', async (_e, href) => {
  const s = typeof href === 'string' ? href.trim() : '';
  if (!/^https:\/\/github\.com\/d1n4styy\/DLTweaker\//i.test(s)) {
    return false;
  }
  await shell.openExternal(s);
  return true;
});

ipcMain.handle('updates-release-notes', async () => {
  try {
    const res = await fetch(GH_RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `DeadlockTweaker/${app.getVersion()} (${process.platform})`,
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        message: `GitHub API: ${res.status}`,
        detail: detail ? String(detail).slice(0, 400) : undefined,
      };
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      return { ok: false, message: 'Неожиданный ответ API' };
    }
    const bundled = await getBundledReleaseNotesMap();
    const items = data.map((r) => {
      const tag = r.tag_name != null ? String(r.tag_name) : '';
      const apiBody = typeof r.body === 'string' ? r.body.trim() : '';
      let fromBundle = '';
      if (tag && bundled[tag] != null) {
        fromBundle = String(bundled[tag]).trim();
      }
      const body = apiBody || fromBundle;
      return {
        tag,
        name: r.name != null ? String(r.name) : '',
        publishedAt: r.published_at != null ? String(r.published_at) : '',
        body,
        url: typeof r.html_url === 'string' ? r.html_url : '',
      };
    });
    return { ok: true, items };
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'Запрос не выполнен';
    return { ok: false, message };
  }
});

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

/** Только проверка версии (без загрузки установщика). */
ipcMain.handle('updates-check-only', async () => {
  const gate = await manualUpdaterDevGate();
  if (gate) return gate;
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
    const msg = err && err.message ? String(err.message) : 'Проверка не удалась';
    return { ok: false, code: 'error', message: msg };
  } finally {
    autoUpdater.autoDownload = prevAuto;
  }
});

/** Проверка + явная загрузка + диалог перезапуска (кнопка «Скачать обновление»). */
ipcMain.handle('updates-download-install', async (event) => {
  const gate = await manualUpdaterDevGate();
  if (gate) return gate;
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
    const msg = err && err.message ? String(err.message) : 'Загрузка не удалась';
    return { ok: false, code: 'error', message: msg };
  } finally {
    autoUpdater.removeListener('download-progress', forwardProgress);
    autoUpdater.autoDownload = prevAuto;
  }
});
