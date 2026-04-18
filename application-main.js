'use strict';

const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { applyQuickPatch, checkQuickPatchOnly, readOverlayCss } = require('./quick-patch');

const execFileAsync = promisify(execFile);

const PROFILES_FILE = 'profiles.json';

/** @type {import('./electron-app-state')} */
let state;
/** @type {{ bringSplashToFront: () => void; closeSplashProgrammatically: () => void }} */
let splashApi;
/** @type {(raw: unknown) => string} */
let sanitizeNetworkErrorMessage;

const GH_RELEASES_API = `https://api.github.com/repos/d1n4styy/DLTweaker/releases?per_page=12`;

const MAIN_WINDOW_WIDTH = 1280;
const MAIN_WINDOW_HEIGHT = 820;
const MAIN_WIN_NATIVE_FRAME = process.platform === 'win32';

let cachedBundledReleaseNotes = undefined;
let cachedQuickPatchChangelog = undefined;

function profilesFilePath() {
  return path.join(app.getPath('userData'), PROFILES_FILE);
}

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

async function getQuickPatchChangelogList() {
  if (cachedQuickPatchChangelog !== undefined) return cachedQuickPatchChangelog;
  try {
    const raw = await fs.readFile(path.join(__dirname, 'quick-patch-changelog.json'), 'utf8');
    const j = JSON.parse(raw);
    if (Array.isArray(j)) {
      cachedQuickPatchChangelog = j;
    } else if (j && typeof j === 'object' && Array.isArray(j.items)) {
      cachedQuickPatchChangelog = j.items;
    } else {
      cachedQuickPatchChangelog = [];
    }
  } catch {
    cachedQuickPatchChangelog = [];
  }
  return cachedQuickPatchChangelog;
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

function createMainWindow() {
  if (state.splashUserAborted) return;
  if (state.mainWin && !state.mainWin.isDestroyed()) {
    if (state.splashWin && !state.splashWin.isDestroyed()) splashApi.closeSplashProgrammatically();
    return;
  }
  state.mainWinSplashCloseScheduled = false;
  state.mainWin = new BrowserWindow({
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
      backgroundThrottling: false,
    },
  });
  try {
    state.mainWin.setBackgroundColor('#0a0a0a');
  } catch {
    /* ignore */
  }

  setupMainWindowSizing(state.mainWin);

  if (MAIN_WIN_NATIVE_FRAME) {
    state.mainWin.webContents.once('dom-ready', () => {
      if (!state.mainWin || state.mainWin.isDestroyed()) return;
      void state.mainWin.webContents.insertCSS(
        '#titlebar{display:none!important}.main-atmosphere{top:0!important}',
      );
    });
  }

  let showFallbackTimer = null;
  const cancelShowFallback = () => {
    if (showFallbackTimer) {
      clearTimeout(showFallbackTimer);
      showFallbackTimer = null;
    }
  };

  function revealMainWindow() {
    const win = state.mainWin;
    if (!win || win.isDestroyed()) return;
    try {
      win.center();
    } catch {
      /* ignore */
    }
    try {
      win.show();
    } catch {
      /* ignore */
    }
    try {
      win.focus();
    } catch {
      /* ignore */
    }
    if (state.splashWin && !state.splashWin.isDestroyed()) {
      try {
        state.splashWin.setAlwaysOnTop(false);
      } catch {
        /* ignore */
      }
    }
    if (!state.mainWinSplashCloseScheduled) {
      state.mainWinSplashCloseScheduled = true;
      setTimeout(() => {
        if (state.splashWin && !state.splashWin.isDestroyed()) {
          splashApi.closeSplashProgrammatically();
        }
      }, 120);
    }
  }

  showFallbackTimer = setTimeout(() => {
    showFallbackTimer = null;
    revealMainWindow();
  }, 12_000);

  state.mainWin.once('ready-to-show', () => {
    if (!state.mainWin || state.mainWin.isDestroyed()) return;
    cancelShowFallback();
    try {
      state.mainWin.setContentSize(MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT);
      state.mainWin.setMinimumSize(MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT);
    } catch {
      /* ignore */
    }
    revealMainWindow();
  });

  state.mainWin.webContents.once('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    cancelShowFallback();
    revealMainWindow();
  });

  state.mainWin.webContents.once('did-finish-load', () => {
    const w = state.mainWin;
    if (!state.mainWin || state.mainWin.isDestroyed()) return;
    cancelShowFallback();
    try {
      state.mainWin.setContentSize(MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT);
      state.mainWin.setMinimumSize(MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT);
    } catch {
      /* ignore */
    }
    revealMainWindow();
    void (async () => {
      const pending = state.splashQuickPatchPromise;
      if (pending) {
        try {
          await pending;
        } catch {
          /* ignore */
        }
        state.splashQuickPatchPromise = null;
      }
      const r = await applyQuickPatch(app, { silent: true });
      if (r && r.ok && r.code === 'applied' && w && !w.isDestroyed()) {
        w.webContents.send('quick-patch-updated');
      }
    })();
  });

  state.mainWin.loadFile('index.html');
  state.mainWin.on('closed', () => {
    state.mainWin = null;
    state.mainWinSplashCloseScheduled = false;
    if (state.splashWin && !state.splashWin.isDestroyed()) {
      splashApi.closeSplashProgrammatically();
    }
  });
}

function notifyUpdatesFlowResumedMain() {
  if (!state.mainWin || state.mainWin.isDestroyed()) return;
  try {
    state.mainWin.webContents.send('updates-flow-resumed');
  } catch {
    /* ignore */
  }
}

function registerAppIpc() {
  ipcMain.on('window-minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });

  ipcMain.on('window-maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return;
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

  ipcMain.handle('quick-patch-check-only', async () => checkQuickPatchOnly(app));

  ipcMain.handle('quick-patch-apply', async () => {
    const r = await applyQuickPatch(app, { silent: false });
    if (r && r.ok && r.code === 'applied' && state.mainWin && !state.mainWin.isDestroyed()) {
      state.mainWin.webContents.send('quick-patch-updated');
    }
    return r;
  });

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
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 12_000);
      let res;
      try {
        res = await fetch(GH_RELEASES_API, {
          signal: ac.signal,
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': `DeadlockTweaker/${app.getVersion()} (${process.platform})`,
          },
        });
      } finally {
        clearTimeout(to);
      }
      const bodyText = await res.text().catch(() => '');
      if (!res.ok) {
        return {
          ok: false,
          message: `GitHub API: ${res.status}`,
          detail: sanitizeNetworkErrorMessage(bodyText).slice(0, 400) || undefined,
        };
      }
      const head = bodyText.trimStart().slice(0, 1);
      if (head === '<') {
        return {
          ok: false,
          message: 'GitHub вернул HTML вместо списка релизов (сеть или лимит запросов).',
        };
      }
      let data;
      try {
        data = JSON.parse(bodyText);
      } catch {
        return { ok: false, message: 'Не удалось разобрать ответ GitHub API.' };
      }
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
      const qpTree = 'https://github.com/d1n4styy/DLTweaker/tree/main/quick-patch';
      const qpRows = await getQuickPatchChangelogList();
      const quickPatchItems = qpRows.map((row) => {
        const id = row && row.id != null ? String(row.id).trim() : '';
        const description =
          row && row.description != null
            ? String(row.description).trim()
            : String((row && row.body) || '').trim();
        const date = row && row.date != null ? String(row.date).trim() : '';
        return {
          tag: id ? `qp:${id}` : 'qp',
          name: id ? `Quick-patch · ${id}` : 'Quick-patch',
          publishedAt: date,
          body: description,
          url: qpTree,
        };
      });
      return { ok: true, items, quickPatchItems };
    } catch (err) {
      const raw =
        err && err.name === 'AbortError'
          ? 'Таймаут запроса к GitHub'
          : err && err.message
            ? String(err.message)
            : 'Запрос не выполнен';
      return { ok: false, message: sanitizeNetworkErrorMessage(raw) };
    }
  });
}

/**
 * @param {{ state: typeof import('./electron-app-state'); splashApi: typeof splashApi; sanitizeNetworkErrorMessage: typeof sanitizeNetworkErrorMessage }} opts
 */
function init(opts) {
  state = opts.state;
  splashApi = opts.splashApi;
  sanitizeNetworkErrorMessage = opts.sanitizeNetworkErrorMessage;
}

module.exports = {
  init,
  createMainWindow,
  notifyUpdatesFlowResumedMain,
  registerAppIpc,
};
