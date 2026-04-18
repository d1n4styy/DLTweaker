/**
 * Предпросмотр окна обновления (splash): правки в splash.html / splash.css / splash-renderer.js
 * подхватываются через перезагрузку страницы. Статусы имитируются как в main при обновлении.
 *
 * Запуск: npm run splash:preview
 * С DevTools: set SPLASH_PREVIEW_DEVTOOLS=1 && npm run splash:preview
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

/** Отдельный профиль и кэш в %TEMP% — не конфликтует с установленным приложением, меньше «Отказано в доступе» у Chromium. */
const PREVIEW_ROOT = path.join(os.tmpdir(), 'deadlock-tweaker-splash-preview');
try {
  fs.mkdirSync(PREVIEW_ROOT, { recursive: true });
  const diskCache = path.join(PREVIEW_ROOT, 'browser-disk-cache');
  fs.mkdirSync(diskCache, { recursive: true });
  app.commandLine.appendSwitch('disk-cache-dir', diskCache);
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.setPath('userData', PREVIEW_ROOT);
  app.setPath('cache', path.join(PREVIEW_ROOT, 'chromium-cache'));
} catch (e) {
  console.warn('[splash-preview] setPath:', e && e.message);
}

const ROOT = path.join(__dirname, '..');
const SPLASH_HTML = path.join(ROOT, 'splash.html');
const PRELOAD = path.join(ROOT, 'splash-preload.js');
const WATCH_FILES = ['splash.html', 'splash.css', 'splash-renderer.js'].map((f) => path.join(ROOT, f));

const SPLASH_CONTENT_WIDTH = 220;
const SPLASH_CONTENT_HEIGHT = 320;

/** @type {import('electron').BrowserWindow | null} */
let win = null;
/** @type {ReturnType<typeof setInterval> | null} */
let demoTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let reloadDebounce = null;

const DEMO_PHASES = [
  { phase: 'checking', message: 'Проверка обновлений…' },
  { phase: 'available', message: 'Доступна версия 9.9.9' },
  {
    phase: 'downloading',
    message: 'Загрузка обновления… 42%',
    percent: 42,
    transferred: 35 * 1024 * 1024,
    total: 83 * 1024 * 1024,
    bytesPerSecond: 5.2 * 1024 * 1024,
  },
  {
    phase: 'installing',
    message: 'Применение обновления…',
    installIndeterminate: true,
    downloadedTotal: 83 * 1024 * 1024,
  },
  { phase: 'uptodate', message: 'Установлена последняя версия' },
];

function clearDemo() {
  if (demoTimer) {
    clearInterval(demoTimer);
    demoTimer = null;
  }
}

function startDemoStatusLoop() {
  clearDemo();
  if (!win || win.isDestroyed()) return;
  let i = 0;
  const send = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('splash-status', DEMO_PHASES[i]);
    i = (i + 1) % DEMO_PHASES.length;
  };
  send();
  demoTimer = setInterval(send, 2600);
}

function scheduleReload() {
  if (reloadDebounce) clearTimeout(reloadDebounce);
  reloadDebounce = setTimeout(() => {
    reloadDebounce = null;
    if (win && !win.isDestroyed()) {
      win.webContents.reload();
    }
  }, 140);
}

function watchSplashFiles() {
  for (const file of WATCH_FILES) {
    try {
      fs.watch(file, { persistent: true }, () => scheduleReload());
    } catch (e) {
      console.warn('[splash-preview] watch failed:', file, e && e.message);
    }
  }
}

function createWindow() {
  if (!fs.existsSync(SPLASH_HTML)) {
    console.error('[splash-preview] Нет файла:', SPLASH_HTML);
    console.error('[splash-preview] Запускайте из корня проекта: npm run splash:preview');
    app.quit();
    return;
  }
  if (!fs.existsSync(PRELOAD)) {
    console.error('[splash-preview] Нет preload:', PRELOAD);
    app.quit();
    return;
  }

  win = new BrowserWindow({
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
    title: 'Splash preview',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    try {
      win.setContentSize(SPLASH_CONTENT_WIDTH, SPLASH_CONTENT_HEIGHT);
      win.center();
    } catch {
      /* ignore */
    }
    win.show();
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[splash-preview] Ошибка загрузки:', errorCode, errorDescription, validatedURL);
  });

  win.loadFile(SPLASH_HTML).catch((err) => {
    console.error('[splash-preview] loadFile:', err);
  });

  win.webContents.on('did-finish-load', () => {
    startDemoStatusLoop();
    if ((process.env.SPLASH_PREVIEW_DEVTOOLS || '').trim() === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  win.on('closed', () => {
    clearDemo();
    win = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  watchSplashFiles();
});

app.on('window-all-closed', () => {
  app.quit();
});
