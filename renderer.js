function formatNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getDashboardRoot() {
  return document.querySelector('[data-view-panel="dashboard"]');
}

function getVisualsRoot() {
  return document.querySelector('[data-view-panel="visuals"]');
}

function getSettingsRoots() {
  return [getDashboardRoot(), getVisualsRoot()].filter(Boolean);
}

function syncSliderRowFill(row) {
  const range = row.querySelector('input[type="range"]');
  const num = row.querySelector('.num-input');
  if (!range || !num) return;
  const min = Number(range.min) || 0;
  const max = Number(range.max) || 100;
  const val = Number(range.value);
  const pct = ((val - min) / (max - min)) * 100;
  range.style.setProperty('--fill', `${pct}%`);
  num.value = range.value;
}

function bindRangeRows() {
  document.querySelectorAll('.slider-row').forEach((row) => {
    const range = row.querySelector('input[type="range"]');
    const num = row.querySelector('.num-input');
    if (!range || !num) return;

    const applyFromRange = () => {
      num.value = range.value;
      syncSliderRowFill(row);
    };

    const applyFromNum = () => {
      let v = Number(num.value);
      const min = Number(range.min);
      const max = Number(range.max);
      if (Number.isNaN(v)) v = min;
      v = Math.min(max, Math.max(min, v));
      num.value = v;
      range.value = String(v);
      syncSliderRowFill(row);
    };

    range.addEventListener('input', applyFromRange);
    num.addEventListener('change', applyFromNum);
    applyFromRange();
  });
}

function collectDashboardSettings() {
  const out = {};
  const dash = getDashboardRoot();
  if (dash) {
    dash.querySelectorAll('.slider-row[data-key]').forEach((row) => {
      const key = row.dataset.key;
      const range = row.querySelector('input[type="range"]');
      if (key && range) out[key] = Number(range.value);
    });
  }

  getSettingsRoots().forEach((r) => {
    r.querySelectorAll('[data-setting]').forEach((el) => {
      const key = el.dataset.setting;
      if (!key) return;
      if (el.classList.contains('js-theme-toggle')) return;
      if (el.type === 'checkbox') out[key] = el.checked;
      else if (el.tagName === 'SELECT') out[key] = el.value;
      else if (el.type === 'color') out[key] = el.value;
    });
  });

  return out;
}

let isApplyingProfile = false;

function applyDashboardSettings(settings) {
  const root = getDashboardRoot();
  if (!root || !settings || typeof settings !== 'object') return;

  isApplyingProfile = true;
  try {
    root.querySelectorAll('.slider-row[data-key]').forEach((row) => {
      const key = row.dataset.key;
      if (key === undefined || settings[key] === undefined) return;
      const range = row.querySelector('input[type="range"]');
      const num = row.querySelector('.num-input');
      if (!range) return;
      const v = Number(settings[key]);
      if (Number.isNaN(v)) return;
      const min = Number(range.min);
      const max = Number(range.max);
      const clamped = Math.min(max, Math.max(min, v));
      range.value = String(clamped);
      if (num) num.value = String(clamped);
      syncSliderRowFill(row);
    });

    getSettingsRoots().forEach((r) => {
      r.querySelectorAll('[data-setting]').forEach((el) => {
        const key = el.dataset.setting;
        if (!key || settings[key] === undefined) return;
        if (el.classList.contains('js-theme-toggle')) return;
        if (el.type === 'checkbox') el.checked = Boolean(settings[key]);
        else if (el.tagName === 'SELECT') {
          const val = String(settings[key]);
          if ([...el.options].some((o) => o.value === val)) el.value = val;
        } else if (el.type === 'color') el.value = String(settings[key]);
      });
    });
  } finally {
    isApplyingProfile = false;
  }
}

function newProfileId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** @type {{ version: number, activeId: string, profiles: { id: string, name: string, settings: Record<string, unknown> }[] } | null} */
let profileStore = null;

async function loadProfileStore() {
  const api = window.electronAPI;
  if (api && typeof api.profilesLoad === 'function') {
    return api.profilesLoad();
  }
  try {
    const raw = localStorage.getItem('dl-profiles-store');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function saveProfileStore(data) {
  const api = window.electronAPI;
  if (api && typeof api.profilesSave === 'function') {
    await api.profilesSave(data);
    return;
  }
  try {
    localStorage.setItem('dl-profiles-store', JSON.stringify(data));
  } catch (e) {
    /* ignore */
  }
}

function normalizeStore(raw) {
  if (!raw || !Array.isArray(raw.profiles) || raw.profiles.length === 0) return null;
  const profiles = raw.profiles
    .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && p.settings && typeof p.settings === 'object')
    .map((p) => ({ id: p.id, name: p.name, settings: { ...p.settings } }));
  if (profiles.length === 0) return null;
  let activeId = typeof raw.activeId === 'string' ? raw.activeId : profiles[0].id;
  if (!profiles.some((p) => p.id === activeId)) activeId = profiles[0].id;
  return { version: 1, activeId, profiles };
}

function getActiveProfile() {
  if (!profileStore) return null;
  return profileStore.profiles.find((p) => p.id === profileStore.activeId) ?? null;
}

function flushCurrentUiToActiveProfile() {
  const active = getActiveProfile();
  if (!active) return;
  active.settings = collectDashboardSettings();
}

function touchStatUpdated() {
  const el = document.getElementById('stat-updated');
  if (el) el.textContent = formatNow();
}

function updateStatProfileName() {
  const stat = document.getElementById('stat-profile');
  const active = getActiveProfile();
  if (stat && active) stat.textContent = active.name;
}

function renderProfileSelect() {
  const sel = document.getElementById('profile-select');
  if (!sel || !profileStore) return;
  const prev = profileStore.activeId;
  sel.innerHTML = '';
  profileStore.profiles.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (profileStore.profiles.some((p) => p.id === prev)) sel.value = prev;
  else sel.value = profileStore.activeId;
}

function renderProfilesList() {
  const ul = document.getElementById('profiles-list');
  if (!ul || !profileStore) return;
  ul.innerHTML = '';
  profileStore.profiles.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'profiles-list-item' + (p.id === profileStore.activeId ? ' is-active' : '');
    li.setAttribute('role', 'listitem');

    const left = document.createElement('div');
    left.className = 'profiles-list-name';
    left.textContent = p.name;
    left.title = p.name;

    const actions = document.createElement('div');
    actions.className = 'profiles-list-actions';

    if (p.id === profileStore.activeId) {
      const pill = document.createElement('span');
      pill.className = 'profiles-pill';
      pill.textContent = 'Active';
      actions.appendChild(pill);
    } else {
      const useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.className = 'btn btn-sm btn-ghost';
      useBtn.textContent = 'Use';
      useBtn.addEventListener('click', () => switchToProfile(p.id));
      actions.appendChild(useBtn);
    }

    li.appendChild(left);
    li.appendChild(actions);
    ul.appendChild(li);
  });
}

let persistTimer = null;

function schedulePersist() {
  if (isApplyingProfile || !profileStore) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    flushCurrentUiToActiveProfile();
    await saveProfileStore(profileStore);
    touchStatUpdated();
  }, 450);
}

function bindDashboardAutosave() {
  const persist = () => schedulePersist();
  const dash = getDashboardRoot();
  if (dash) {
    dash.addEventListener('input', (e) => {
      if (e.target.closest('.profile-bar')) return;
      persist();
    });
    dash.addEventListener('change', (e) => {
      if (e.target.closest('.profile-bar')) return;
      persist();
    });
  }
  const vis = getVisualsRoot();
  if (vis) {
    vis.addEventListener('input', persist);
    vis.addEventListener('change', persist);
  }
}

async function switchToProfile(id) {
  if (!profileStore || !profileStore.profiles.some((p) => p.id === id)) return;
  if (id === profileStore.activeId) {
    renderProfileSelect();
    updateStatProfileName();
    return;
  }
  flushCurrentUiToActiveProfile();
  profileStore.activeId = id;
  const next = getActiveProfile();
  if (next) applyDashboardSettings(next.settings);
  await saveProfileStore(profileStore);
  renderProfileSelect();
  renderProfilesList();
  updateStatProfileName();
  touchStatUpdated();
}

function bindProfileSelect() {
  const sel = document.getElementById('profile-select');
  if (!sel) return;
  sel.addEventListener('change', () => {
    switchToProfile(sel.value);
  });
}

function bindProfileToolbar() {
  const modalRoot = document.getElementById('modal-root');
  const modalAdd = document.getElementById('modal-add');
  const modalDelete = document.getElementById('modal-delete');
  const modalAddInput = document.getElementById('modal-add-input');
  const modalDeleteName = document.getElementById('modal-delete-name');
  let pendingDeleteId = null;

  function closeModals() {
    if (!modalRoot) return;
    modalRoot.classList.remove('is-open');
    modalRoot.setAttribute('aria-hidden', 'true');
    modalAdd?.classList.add('hidden');
    modalDelete?.classList.add('hidden');
    pendingDeleteId = null;
  }

  function openAddModal() {
    if (!profileStore) return;
    if (!modalRoot || !modalAdd || !modalDelete || !modalAddInput) return;
    modalDelete.classList.add('hidden');
    modalAdd.classList.remove('hidden');
    modalRoot.classList.add('is-open');
    modalRoot.setAttribute('aria-hidden', 'false');
    modalAddInput.value = '';
    requestAnimationFrame(() => {
      modalAddInput.focus({ preventScroll: true });
    });
    setTimeout(() => {
      if (modalRoot.classList.contains('is-open') && !modalAdd.classList.contains('hidden')) {
        modalAddInput.focus({ preventScroll: true });
      }
    }, 100);
  }

  function openDeleteModal() {
    if (!profileStore || profileStore.profiles.length <= 1) {
      window.alert('Нужен хотя бы один профиль.');
      return;
    }
    const sel = document.getElementById('profile-select');
    const deleteId = sel?.value;
    const victim = profileStore.profiles.find((p) => p.id === deleteId);
    if (!victim || !modalRoot || !modalAdd || !modalDelete || !modalDeleteName) return;
    pendingDeleteId = deleteId;
    modalDeleteName.textContent = victim.name;
    modalAdd.classList.add('hidden');
    modalDelete.classList.remove('hidden');
    modalRoot.classList.add('is-open');
    modalRoot.setAttribute('aria-hidden', 'false');
  }

  document.getElementById('profile-add')?.addEventListener('click', () => openAddModal());

  document.getElementById('modal-add-cancel')?.addEventListener('click', closeModals);

  document.getElementById('modal-add-confirm')?.addEventListener('click', async () => {
    if (!profileStore || !modalAddInput) return;
    const name = modalAddInput.value.trim();
    if (!name) {
      modalAddInput.focus();
      return;
    }
    closeModals();
    flushCurrentUiToActiveProfile();
    const settings = { ...collectDashboardSettings() };
    const id = newProfileId();
    profileStore.profiles.push({ id, name, settings });
    profileStore.activeId = id;
    await saveProfileStore(profileStore);
    renderProfileSelect();
    renderProfilesList();
    updateStatProfileName();
    touchStatUpdated();
  });

  modalAddInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('modal-add-confirm')?.click();
    }
  });

  document.getElementById('profile-save')?.addEventListener('click', async () => {
    const btn = document.getElementById('profile-save');
    if (!profileStore || !getActiveProfile() || !btn) return;
    if (btn.dataset.saveBusy === '1') return;

    const labelDefault = btn.dataset.labelDefault || btn.textContent.trim() || 'Save';
    if (!btn.dataset.labelDefault) btn.dataset.labelDefault = labelDefault;

    btn.dataset.saveBusy = '1';
    btn.classList.add('profile-save--busy');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');

    try {
      flushCurrentUiToActiveProfile();
      await saveProfileStore(profileStore);
      renderProfilesList();
      updateStatProfileName();
      touchStatUpdated();

      btn.classList.remove('profile-save--busy');
      btn.classList.add('profile-save--done');
      btn.textContent = 'Saved ✓';
      btn.setAttribute('aria-label', 'Profile saved');

      window.setTimeout(() => {
        btn.textContent = btn.dataset.labelDefault || 'Save';
        btn.classList.remove('profile-save--done');
        btn.removeAttribute('aria-label');
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        delete btn.dataset.saveBusy;
      }, 1600);
    } catch {
      btn.classList.remove('profile-save--busy');
      btn.textContent = 'Save failed';
      btn.setAttribute('aria-label', 'Save failed');
      window.setTimeout(() => {
        btn.textContent = btn.dataset.labelDefault || 'Save';
        btn.removeAttribute('aria-label');
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        delete btn.dataset.saveBusy;
      }, 2000);
    }
  });

  document.getElementById('profile-delete')?.addEventListener('click', () => openDeleteModal());

  document.getElementById('modal-delete-cancel')?.addEventListener('click', closeModals);

  document.getElementById('modal-delete-confirm')?.addEventListener('click', async () => {
    if (!profileStore || !pendingDeleteId) {
      closeModals();
      return;
    }
    const deleteId = pendingDeleteId;
    closeModals();

    const wasActive = deleteId === profileStore.activeId;
    profileStore.profiles = profileStore.profiles.filter((p) => p.id !== deleteId);
    if (wasActive || !profileStore.profiles.some((p) => p.id === profileStore.activeId)) {
      profileStore.activeId = profileStore.profiles[0].id;
      applyDashboardSettings(profileStore.profiles[0].settings);
    }
    await saveProfileStore(profileStore);
    renderProfileSelect();
    renderProfilesList();
    updateStatProfileName();
    touchStatUpdated();
  });

  modalRoot?.querySelectorAll('[data-modal-dismiss]').forEach((el) => {
    el.addEventListener('click', closeModals);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalRoot?.classList.contains('is-open')) {
      e.preventDefault();
      closeModals();
    }
  });
}

async function initProfiles() {
  let raw = await loadProfileStore();
  let store = normalizeStore(raw);

  if (!store) {
    const id = newProfileId();
    const settings = collectDashboardSettings();
    store = {
      version: 1,
      activeId: id,
      profiles: [{ id, name: 'Default', settings }],
    };
    await saveProfileStore(store);
  }

  profileStore = store;
  const active = getActiveProfile();
  if (active) applyDashboardSettings(active.settings);
  renderProfileSelect();
  renderProfilesList();
  updateStatProfileName();
}

function bindNav() {
  const nav = document.getElementById('main-nav');
  if (!nav) return;

  nav.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (!view) return;

      nav.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('[data-view-panel]').forEach((panel) => {
        const match = panel.dataset.viewPanel === view;
        panel.classList.toggle('hidden', !match);
      });

      if (view === 'profiles') renderProfilesList();
      if (view === 'settings') void loadUpdatesChangelog();
    });
  });
}

let updatesChangelogLoaded = false;
let updatesChangelogLoading = false;

function formatReleaseDateRu(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return String(iso);
  }
}

/** GitHub release bodies are Markdown; keep readable plain text in UI. */
function simplifyReleaseBody(raw) {
  if (raw == null) return '';
  let s = String(raw).replace(/\r\n/g, '\n');
  s = s.replace(/^---[\s\S]*?^---\s*/m, '');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/^\s*[-*]\s+/gm, '• ');
  return s.trim();
}

async function loadUpdatesChangelog() {
  const listEl = document.getElementById('updates-changelog-list');
  const statusEl = document.getElementById('updates-changelog-status');
  const api = window.electronAPI;
  if (!listEl || !statusEl || !api || typeof api.fetchReleaseNotes !== 'function') return;
  if (updatesChangelogLoading || updatesChangelogLoaded) return;

  updatesChangelogLoading = true;
  statusEl.textContent = 'Загрузка списка релизов…';
  statusEl.className = 'updates-changelog-foot';

  try {
    const res = await api.fetchReleaseNotes();
    if (!res || !res.ok) {
      statusEl.classList.add('is-error');
      statusEl.textContent = res?.message || 'Не удалось загрузить релизы';
      updatesChangelogLoading = false;
      return;
    }

    listEl.textContent = '';
    const items = Array.isArray(res.items) ? res.items : [];
    if (items.length === 0) {
      statusEl.textContent = 'Пока нет опубликованных релизов.';
      updatesChangelogLoaded = true;
      updatesChangelogLoading = false;
      return;
    }

    items.forEach((it) => {
      const article = document.createElement('article');
      article.className = 'updates-changelog-item';
      article.setAttribute('role', 'listitem');

      const head = document.createElement('div');
      head.className = 'updates-changelog-head';

      const h = document.createElement('h3');
      h.className = 'updates-changelog-title';
      const title = (it.name && String(it.name).trim()) || (it.tag && String(it.tag).trim()) || 'Релиз';
      h.textContent = title;

      const meta = document.createElement('p');
      meta.className = 'updates-changelog-meta';
      const parts = [it.tag && String(it.tag).trim(), formatReleaseDateRu(it.publishedAt)].filter(Boolean);
      meta.textContent = parts.join(' · ');

      head.append(h, meta);

      const body = document.createElement('p');
      body.className = 'updates-changelog-body';
      const btxt = simplifyReleaseBody(it.body);
      body.textContent = btxt || 'Нет описания для этого релиза.';

      article.append(head, body);

      if (it.url && typeof api.openExternalGithub === 'function') {
        const row = document.createElement('div');
        row.className = 'updates-changelog-link';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-ghost btn-sm';
        b.textContent = 'Открыть на GitHub';
        b.addEventListener('click', () => {
          void api.openExternalGithub(it.url);
        });
        row.append(b);
        article.append(row);
      }

      listEl.append(article);
    });

    statusEl.textContent = '';
    updatesChangelogLoaded = true;
  } catch (e) {
    statusEl.classList.add('is-error');
    statusEl.textContent = e && e.message ? String(e.message) : 'Ошибка';
  }
  updatesChangelogLoading = false;
}

const TITLEBAR_MAX_SVG =
  '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" /></svg>';
const TITLEBAR_RESTORE_SVG =
  '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><rect x="0.5" y="2.5" width="6" height="6" /><rect x="3.5" y="0.5" width="6" height="6" /></svg>';

function applyNativeWindowFrameClass() {
  try {
    const api = window.electronAPI;
    const ua = navigator.userAgent || '';
    const electronWin = /\bElectron\b/i.test(ua) && /\bWindows\b/i.test(ua);
    if ((api && api.useNativeWindowFrame) || electronWin) {
      document.documentElement.classList.add('dl-native-win-frame');
    }
  } catch {
    /* ignore */
  }
}

async function syncTitlebarMaxIcon() {
  const api = window.electronAPI;
  const btn = document.getElementById('btn-max');
  if (!api || typeof api.isMaximized !== 'function' || !btn) return;
  try {
    const maxed = await api.isMaximized();
    btn.innerHTML = maxed ? TITLEBAR_RESTORE_SVG : TITLEBAR_MAX_SVG;
    btn.setAttribute('aria-label', maxed ? 'Восстановить размер окна' : 'Развернуть на рабочую область');
  } catch {
    /* ignore */
  }
}

function bindTitlebar() {
  const api = window.electronAPI;
  if (!api) return;
  if (api.useNativeWindowFrame) return;

  document.getElementById('btn-min')?.addEventListener('click', () => api.minimize());

  const btnMax = document.getElementById('btn-max');
  if (btnMax) {
    btnMax.addEventListener('click', () => {
      api.maximize();
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => void syncTitlebarMaxIcon());
      });
    });
  }

  document.getElementById('btn-close')?.addEventListener('click', () => api.close());

  void syncTitlebarMaxIcon();
  let resizeT;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeT);
    resizeT = window.setTimeout(() => void syncTitlebarMaxIcon(), 120);
  });
}

function applyGameStatusUI(status) {
  const running = Boolean(status?.running);
  const err = Boolean(status?.error);
  const dot = document.getElementById('game-detect-dot');
  const headLabel = document.getElementById('game-detect-head-label');
  const pill = document.getElementById('game-status-pill');
  const statLabel = document.getElementById('stat-game-label');
  const statPulse = document.getElementById('stat-game-pulse');
  const statWrap = document.getElementById('stat-game-status');

  if (dot) dot.classList.toggle('dot-on', running);

  if (headLabel) {
    if (err) headLabel.textContent = 'Status unknown';
    else headLabel.textContent = running ? 'Game detected' : 'Game not running';
  }

  if (pill) {
    if (err) pill.textContent = '—';
    else pill.textContent = running ? 'Running' : 'Not running';
    pill.classList.toggle('game-status-pill--off', !running || err);
  }

  if (statLabel) {
    if (err) statLabel.textContent = 'Unknown';
    else statLabel.textContent = running ? 'Running' : 'Not running';
  }

  if (statWrap) {
    statWrap.classList.toggle('stat-live', running);
    statWrap.classList.toggle('stat-idle', !running || err);
  }

  if (statPulse) {
    if (running) statPulse.removeAttribute('hidden');
    else statPulse.setAttribute('hidden', '');
  }
}

async function refreshGameStatus() {
  const api = window.electronAPI;
  if (!api?.getGameProcessStatus) {
    applyGameStatusUI({ running: false, error: true });
    return;
  }
  try {
    const status = await api.getGameProcessStatus();
    applyGameStatusUI(status);
  } catch (e) {
    applyGameStatusUI({ running: false, error: true });
  }
}

function startGameStatusPolling() {
  void refreshGameStatus();
  window.setInterval(() => {
    void refreshGameStatus();
  }, 2800);
}

const THEME_KEY = 'dl-theme';

function applyTheme(isLight) {
  const root = document.documentElement;
  if (isLight) root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  try {
    localStorage.setItem(THEME_KEY, isLight ? 'light' : 'dark');
  } catch (e) {
    /* ignore */
  }
}

function syncThemeToggles(isLight) {
  document.querySelectorAll('.js-theme-toggle').forEach((el) => {
    el.checked = isLight;
  });
}

function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  const isLight = stored === 'light';
  applyTheme(isLight);
  syncThemeToggles(isLight);
}

function bindThemeToggle() {
  document.querySelectorAll('.js-theme-toggle').forEach((toggle) => {
    toggle.addEventListener('change', () => {
      const on = toggle.checked;
      applyTheme(on);
      syncThemeToggles(on);
    });
  });
}

const VISUALS_SCRUB_POS_KEY = 'dl-visuals-compare-scrub';

function hiDpiVariantPath(baseSrc) {
  const i = baseSrc.lastIndexOf('.');
  if (i <= 0) return `${baseSrc}@2x`;
  return `${baseSrc.slice(0, i)}@2x${baseSrc.slice(i)}`;
}

const DEFAULT_COMPARE_OFF = 'Screens/ShadowsOFF.png';
const DEFAULT_COMPARE_ON = 'Screens/ShadowsON.png';
const FALLBACK_COMPARE = 'assets/visuals-shadow-compare.png';

function probeImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

async function resolveExistingImage(candidates) {
  for (const src of candidates) {
    if (!src) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await probeImage(src)) return src;
  }
  return null;
}

function expandCompareCandidates(primary) {
  const p = (primary || '').trim();
  if (!p) return [];
  const out = [p];
  const dot = p.lastIndexOf('.');
  const stem = dot > 0 ? p.slice(0, dot) : p;
  out.push(`${stem}.jpg`, `${stem}.jpeg`, `${stem}.png`, `${stem}.jpb`);
  out.push(`${stem}.JPG`, `${stem}.JPEG`, `${stem}.PNG`, `${stem}.JPB`);
  return [...new Set(out)];
}

/** Apply `data-compare-off` / `data-compare-on` on the scrub root (defaults: Screens/ShadowsOFF.png & ShadowsON.png). */
async function applyVisualsCompareSrcFromDataset() {
  const root = document.getElementById('visuals-compare-scrub');
  if (!root) return;
  const offRequested = (root.dataset.compareOff || DEFAULT_COMPARE_OFF).trim();
  const onRequested = (root.dataset.compareOn || DEFAULT_COMPARE_ON).trim();
  const off = await resolveExistingImage([...expandCompareCandidates(offRequested), FALLBACK_COMPARE]);
  const on = await resolveExistingImage([...expandCompareCandidates(onRequested), off || FALLBACK_COMPARE]);
  const base = root.querySelector('.visuals-scrub__base');
  const top = root.querySelector('.visuals-scrub__top');
  if (base && off) base.src = off;
  if (top && on) top.src = on;
}

/** If a @2x file exists next to each name, enable srcset on that image. */
async function initVisualsCompareAsset() {
  await applyVisualsCompareSrcFromDataset();

  function applySrcsetIfHiDpi(img) {
    if (!img) return;
    const baseSrc = img.getAttribute('src');
    if (!baseSrc) return;
    const hidpi = hiDpiVariantPath(baseSrc);
    const probe = new Image();
    probe.onload = () => {
      img.setAttribute('srcset', `${baseSrc} 1x, ${hidpi} 2x`);
    };
    probe.onerror = () => {};
    probe.src = hidpi;
  }

  const root = document.getElementById('visuals-compare-scrub');
  if (!root) return;
  applySrcsetIfHiDpi(root.querySelector('.visuals-scrub__base'));
  applySrcsetIfHiDpi(root.querySelector('.visuals-scrub__top'));
}

async function refreshQuickPatchCss() {
  const api = window.electronAPI;
  if (!api || typeof api.quickPatchGetCss !== 'function') return;
  try {
    const css = await api.quickPatchGetCss();
    const existing = document.getElementById('dl-quick-patch-css');
    if (!css) {
      if (existing) existing.remove();
      return;
    }
    const el = existing || document.createElement('style');
    if (!existing) {
      el.id = 'dl-quick-patch-css';
      document.head.appendChild(el);
    }
    el.textContent = css;
  } catch {
    /* ignore */
  }
}

async function initQuickPatchStyles() {
  await refreshQuickPatchCss();
  const api = window.electronAPI;
  if (api && typeof api.onQuickPatchUpdated === 'function') {
    api.onQuickPatchUpdated(() => void refreshQuickPatchCss());
  }
}

function bindSettingsUpdates() {
  const verEl = document.getElementById('settings-app-version');
  const btnCheck = document.getElementById('settings-check-updates');
  const btnDl = document.getElementById('settings-download-updates');
  const msg = document.getElementById('settings-update-msg');
  const api = window.electronAPI;
  if (!verEl || !api || typeof api.getAppVersion !== 'function') return;

  void api.getAppVersion().then(
    (v) => {
      verEl.textContent = v || '—';
    },
    () => {
      verEl.textContent = '—';
    },
  );

  if (!btnCheck || !btnDl || !msg) return;
  if (typeof api.checkUpdatesOnly !== 'function' || typeof api.downloadUpdatesInstall !== 'function') return;

  if (typeof api.onUpdatesFlowResumed === 'function') {
    api.onUpdatesFlowResumed(() => {
      clearProgress();
      btnCheck.disabled = false;
      btnDl.disabled = true;
      setMsg('Готово.', '');
    });
  }

  /** @type {null | (() => void)} */
  let unsubProgress = null;

  function clearProgress() {
    if (typeof unsubProgress === 'function') {
      unsubProgress();
      unsubProgress = null;
    }
  }

  function setMsg(text, tone) {
    msg.textContent = text;
    msg.className = 'settings-update-msg';
    if (tone === 'ok') msg.classList.add('is-ok');
    else if (tone === 'warn') msg.classList.add('is-warn');
    else if (tone === 'err') msg.classList.add('is-error');
  }

  btnCheck.addEventListener('click', async () => {
    clearProgress();
    setMsg('Проверка…', '');
    btnCheck.disabled = true;
    btnDl.disabled = true;
    try {
      const r = await api.checkUpdatesOnly();
      if (!r || !r.ok) {
        setMsg(r?.message || 'Не удалось проверить обновления', 'err');
        btnDl.disabled = true;
      } else if (r.code === 'uptodate') {
        setMsg(`Установлена последняя версия (${r.currentVersion || 'текущая'}).`, 'ok');
        btnDl.disabled = true;
      } else if (r.code === 'available') {
        setMsg(`Доступна версия ${r.version}. Нажмите «Скачать обновление».`, 'ok');
        btnDl.disabled = false;
      } else if (r.code === 'dev') {
        setMsg(r.message || 'Режим разработки', 'warn');
        btnDl.disabled = true;
      } else if (r.code === 'noconfig') {
        setMsg(r.message || 'Канал обновлений не настроен', 'err');
        btnDl.disabled = true;
      } else {
        setMsg(r.message || 'Готово', '');
        btnDl.disabled = true;
      }
    } catch (e) {
      setMsg(e && e.message ? String(e.message) : 'Ошибка', 'err');
      btnDl.disabled = true;
    }
    btnCheck.disabled = false;
  });

  btnDl.addEventListener('click', async () => {
    clearProgress();
    setMsg('Открываем окно обновления…', '');
    btnDl.disabled = true;
    btnCheck.disabled = true;
    try {
      let r =
        typeof api.downloadUpdatesViaSplash === 'function'
          ? await api.downloadUpdatesViaSplash()
          : { ok: false, code: 'dev' };
      if (r && r.code === 'dev') {
        setMsg('Загрузка…', '');
        if (typeof api.onSettingsUpdateDownloadProgress === 'function') {
          unsubProgress = api.onSettingsUpdateDownloadProgress((p) => {
            const pct = Math.round(Number(p && p.percent) || 0);
            setMsg(`Загрузка ${pct}%`, '');
          });
        }
        r = await api.downloadUpdatesInstall();
      }
      if (!r || !r.ok) {
        if (r?.code === 'busy') {
          setMsg(r.message || 'Подождите…', 'warn');
        } else {
          setMsg(r?.message || 'Не удалось начать обновление', 'err');
        }
        btnDl.disabled = false;
      } else if (r.code === 'splash') {
        setMsg('Проверка и загрузка на экране запуска…', 'ok');
        btnDl.disabled = true;
      } else if (r.code === 'uptodate') {
        setMsg(`Установлена последняя версия (${r.currentVersion || 'текущая'}).`, 'ok');
        btnDl.disabled = true;
      } else if (r.code === 'restarting') {
        setMsg('Перезапуск для установки…', 'ok');
        btnDl.disabled = true;
      } else if (r.code === 'downloaded') {
        setMsg(r.message || 'Обновление скачано.', 'ok');
        btnDl.disabled = true;
      } else {
        setMsg(r.message || 'Готово', '');
        btnDl.disabled = true;
      }
    } catch (e) {
      setMsg(e && e.message ? String(e.message) : 'Ошибка', 'err');
      btnDl.disabled = false;
    } finally {
      clearProgress();
      btnCheck.disabled = false;
    }
  });
}

function bindVisualsCompareScrubber() {
  const root = document.getElementById('visuals-compare-scrub');
  const range = document.getElementById('visuals-scrub-range');
  const pill = document.getElementById('visuals-scrub-pill');
  if (!root || !range) return;

  function setPill(n) {
    if (!pill) return;
    if (n < 50) {
      pill.textContent = 'ON';
      pill.className = 'visuals-scrub__pill visuals-scrub__pill--on';
    } else if (n > 50) {
      pill.textContent = 'OFF';
      pill.className = 'visuals-scrub__pill visuals-scrub__pill--off';
    } else {
      pill.textContent = 'ON · OFF';
      pill.className = 'visuals-scrub__pill visuals-scrub__pill--mid';
    }
  }

  function applyPct(raw) {
    const n = Math.min(100, Math.max(0, Number(raw) || 0));
    root.style.setProperty('--split', `${n}%`);
    setPill(n);
    const hint = n < 50 ? 'Seam left of center — preview reads ON' : n > 50 ? 'Seam right of center — preview reads OFF' : 'Seam centered';
    range.setAttribute('aria-valuetext', `${Math.round(n)}%. ${hint}`);
  }

  let stored = 50;
  try {
    const t = localStorage.getItem(VISUALS_SCRUB_POS_KEY);
    if (t != null && t !== '') stored = Math.min(100, Math.max(0, Number(t)));
  } catch (e) {
    /* ignore */
  }
  range.value = String(stored);
  applyPct(stored);

  range.addEventListener('input', () => applyPct(range.value));
  range.addEventListener('change', () => {
    try {
      localStorage.setItem(VISUALS_SCRUB_POS_KEY, String(Math.round(Number(range.value) * 10) / 10));
    } catch (e) {
      /* ignore */
    }
  });

}

document.getElementById('stat-updated').textContent = formatNow();
applyNativeWindowFrameClass();
initTheme();
bindThemeToggle();
bindRangeRows();
bindNav();
bindTitlebar();
initVisualsCompareAsset();
bindVisualsCompareScrubber();
void initQuickPatchStyles();
bindSettingsUpdates();
startGameStatusPolling();

(async () => {
  await initProfiles();
  bindProfileSelect();
  bindProfileToolbar();
  bindDashboardAutosave();
  touchStatUpdated();
})();
