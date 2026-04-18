const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const OWNER = 'd1n4styy';
const REPO = 'DLTweaker';
const BRANCH = 'main';
const MANIFEST_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/quick-patch/manifest.json`;

function quickPatchRoot(userData) {
  return path.join(userData, 'quick-patch');
}

function semverStrip(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .trim();
}

function semverParts(v) {
  const s = semverStrip(v);
  const [a = '0', b = '0', c = '0'] = s.split('.');
  return [parseInt(a, 10) || 0, parseInt(b, 10) || 0, parseInt(c, 10) || 0];
}

function semverCompare(a, b) {
  const [a1, a2, a3] = semverParts(a);
  const [b1, b2, b3] = semverParts(b);
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  if (a3 !== b3) return a3 < b3 ? -1 : 1;
  return 0;
}

function inSemverRange(cur, min, max) {
  return semverCompare(cur, min) >= 0 && semverCompare(cur, max) <= 0;
}

function safeFilename(name) {
  const s = String(name).trim();
  if (!s || !/^[a-zA-Z0-9._-]+$/.test(s) || s.includes('..')) return null;
  return s;
}

function allowedAssetUrl(u) {
  const s = String(u);
  return (
    s.startsWith(`https://raw.githubusercontent.com/${OWNER}/${REPO}/`) ||
    s.startsWith(`https://github.com/${OWNER}/${REPO}/raw/`)
  );
}

async function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** LF как у raw.githubusercontent.com; манифест часто считают на Windows с CRLF — иначе ложное «не сошлась сумма». */
function normalizeTextAssetBytes(buf, filename) {
  if (!filename || !/\.(css|json|html?|md|txt|yml|yaml)$/i.test(filename)) {
    return buf;
  }
  try {
    const t = buf.toString('utf8');
    return Buffer.from(t.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
  } catch {
    return buf;
  }
}

async function loadState(root) {
  try {
    const raw = await fs.readFile(path.join(root, 'state.json'), 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

async function saveState(root, state) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'DeadlockTweaker/quick-patch',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const raw = await res.text();
    const start = raw.trimStart();
    if (start.startsWith('<') || ct.includes('text/html')) {
      throw new Error('Вместо манифеста пришла HTML-страница (сеть, прокси или блокировка).');
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('Ответ не является корректным JSON.');
    }
  } finally {
    clearTimeout(t);
  }
}

async function fetchAsset(url, maxBytes) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 35000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'DeadlockTweaker/quick-patch' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > maxBytes) throw new Error('Слишком большой файл');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('Слишком большой файл');
    return buf;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Разбор манифеста и локального состояния без загрузки файлов.
 * @param {import('electron').App} app
 * @param {boolean} silent
 */
async function resolveQuickPatchStatus(app, silent) {
  const userData = app.getPath('userData');
  const root = quickPatchRoot(userData);
  const activeDir = path.join(root, 'active');
  const curVer = app.getVersion();
  const maxAsset = 3 * 1024 * 1024;

  let manifest;
  try {
    manifest = await fetchJson(MANIFEST_URL, 10_000);
  } catch (e) {
    const msg =
      e && e.name === 'AbortError'
        ? 'таймаут (10 с)'
        : e && e.message
          ? String(e.message)
          : 'ошибка сети';
    return { ok: false, code: 'fetch', message: silent ? '' : `Манифест: ${msg}` };
  }

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, code: 'bad', message: silent ? '' : 'Некорректный манифест' };
  }

  const id = typeof manifest.id === 'string' ? manifest.id.trim() : '';
  const minV = semverStrip(manifest.minAppSemver || '0.0.0');
  const maxV = semverStrip(manifest.maxAppSemver || '999.999.999');
  if (!id) {
    return { ok: false, code: 'bad', message: silent ? '' : 'В манифесте нет id' };
  }

  if (!inSemverRange(curVer, minV, maxV)) {
    return {
      ok: true,
      code: 'range',
      message: silent ? '' : `Этот патч не для версии ${curVer} (диапазон ${minV}…${maxV}).`,
      id,
      minV,
      maxV,
    };
  }

  const state = await loadState(root);
  const appliedId = typeof state.appliedId === 'string' ? state.appliedId : '';
  if (appliedId === id) {
    return { ok: true, code: 'uptodate', message: silent ? '' : 'Уже применён.', id };
  }

  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (assets.length === 0) {
    return {
      ok: true,
      code: 'noop',
      message: silent ? '' : 'В манифесте пока нет файлов — для правок только текста/CSS добавьте assets.',
      id,
    };
  }

  const description =
    typeof manifest.description === 'string' ? manifest.description.trim() : '';

  return {
    ok: true,
    code: 'available',
    id,
    description,
    message: silent ? '' : description ? `Доступен патч «${id}».` : `Доступен патч «${id}».`,
    root,
    activeDir,
    state,
    assets,
    maxAsset,
  };
}

/** Только проверка (без записи файлов), для вкладки «Обновления». */
async function checkQuickPatchOnly(app) {
  const st = await resolveQuickPatchStatus(app, false);
  if (!st.ok) {
    return { ok: false, code: st.code, message: st.message || '' };
  }
  if (st.code === 'available') {
    return {
      ok: true,
      code: 'available',
      id: st.id,
      description: st.description || '',
      message: st.message || '',
    };
  }
  return {
    ok: true,
    code: st.code,
    message: st.message || '',
    id: st.id,
    minV: st.minV,
    maxV: st.maxV,
  };
}

/**
 * @param {import('electron').App} app
 * @param {{ silent?: boolean }} opts
 */
async function applyQuickPatch(app, opts) {
  const silent = Boolean(opts && opts.silent);
  const st = await resolveQuickPatchStatus(app, silent);
  if (!st.ok) {
    return { ok: false, code: st.code, message: st.message };
  }
  if (st.code === 'range' || st.code === 'uptodate' || st.code === 'noop') {
    return { ok: true, code: st.code, message: st.message, id: st.id };
  }
  if (st.code !== 'available') {
    return { ok: false, code: 'bad', message: silent ? '' : 'Неизвестное состояние патча' };
  }

  const { root, activeDir, state, assets, maxAsset, id } = st;
  await fs.mkdir(activeDir, { recursive: true });

  for (const a of assets) {
    const url = typeof a.url === 'string' ? a.url.trim() : '';
    const rel = safeFilename(typeof a.path === 'string' ? a.path : typeof a.name === 'string' ? a.name : '');
    if (!url || !rel || !allowedAssetUrl(url)) {
      return { ok: false, code: 'bad', message: 'Недопустимый URL или имя файла' };
    }
    let buf = await fetchAsset(url, maxAsset);
    buf = normalizeTextAssetBytes(buf, rel);
    if (a.sha256) {
      const want = String(a.sha256).toLowerCase();
      const got = await sha256Buffer(buf);
      if (want !== got) {
        return {
          ok: false,
          code: 'hash',
          message: 'Не сошлась контрольная сумма загруженного файла.',
        };
      }
    }
    await fs.writeFile(path.join(activeDir, rel), buf);
  }

  await saveState(root, { ...state, appliedId: id, appliedAt: new Date().toISOString() });
  return { ok: true, code: 'applied', message: silent ? '' : `Патч «${id}» загружен.`, id };
}

async function readOverlayCss(app) {
  const dir = path.join(quickPatchRoot(app.getPath('userData')), 'active');
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const cssNames = names.filter((f) => f.endsWith('.css')).sort();
  if (cssNames.length === 0) return null;
  const parts = await Promise.all(cssNames.map((f) => fs.readFile(path.join(dir, f), 'utf8')));
  return parts.join('\n\n');
}

module.exports = {
  applyQuickPatch,
  checkQuickPatchOnly,
  readOverlayCss,
};
