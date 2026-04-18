(function () {
  const api = window.splashAPI;
  const line = document.getElementById('splash-line');
  const sub = document.getElementById('splash-sub');
  const progressWrap = document.getElementById('splash-progress-wrap');
  const progressBar = progressWrap && progressWrap.querySelector('.progress');
  const progressFill = document.getElementById('splash-progress-fill');

  function formatBytes(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    let v = Number(n);
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    if (i === 0) return `${Math.round(v)} ${units[i]}`;
    const dec = v < 10 && i > 0 ? 1 : 0;
    return `${v.toFixed(dec)} ${units[i]}`;
  }

  function setIndeterminate(on) {
    if (progressBar) {
      progressBar.classList.toggle('indeterminate', Boolean(on));
    }
  }

  function setProgress(pct, opts) {
    const options = opts || {};
    if (pct == null || Number.isNaN(pct)) {
      if (!options.keepVisible) {
        progressWrap.hidden = true;
        progressFill.style.width = '0%';
        setIndeterminate(false);
      }
      return;
    }
    progressWrap.hidden = false;
    setIndeterminate(Boolean(options.indeterminate));
    if (options.indeterminate) {
      progressFill.style.width = '';
    } else {
      const v = Math.max(0, Math.min(100, pct));
      progressFill.style.width = `${v}%`;
    }
  }

  function applyPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (line && payload.message) line.textContent = payload.message;
    if (sub) {
      const hints = {
        checking: 'Подключение к серверу обновлений',
        available: 'Скоро начнётся загрузка',
        downloading: 'Не закрывайте это окно',
        installing: 'Тихий режим: отдельное окно мастера не показывается',
        uptodate: 'Переход к основному окну',
        launching: 'Почти готово',
        offline: 'Обновления недоступны, открываем приложение',
        dev: 'Сборка разработчика',
        updatedone: 'Открываем основное приложение',
      };
      let extra = '';
      if (payload.phase === 'downloading') {
        const t = payload.transferred;
        const tot = payload.total;
        const bps = payload.bytesPerSecond;
        if (t != null && tot != null) {
          extra = `${formatBytes(t)} из ${formatBytes(tot)}`;
          if (bps != null && !Number.isNaN(Number(bps)) && Number(bps) > 0) {
            extra += ` · ${formatBytes(bps)}/с`;
          }
        }
      } else if (
        payload.phase === 'installing' &&
        payload.downloadedTotal != null &&
        Number(payload.downloadedTotal) > 0
      ) {
        extra = `Загружено ${formatBytes(payload.downloadedTotal)} · установка без окна мастера`;
      }
      sub.textContent = extra || hints[payload.phase] || '';
    }
    if (payload.phase === 'downloading' && typeof payload.percent === 'number') {
      setProgress(payload.percent, { indeterminate: false });
    } else if (payload.phase === 'installing' && payload.installIndeterminate) {
      setProgress(0, { indeterminate: true });
    } else if (payload.phase === 'updatedone' && typeof payload.percent === 'number') {
      setProgress(payload.percent, { indeterminate: false });
    } else if (payload.phase === 'launching' && typeof payload.percent === 'number') {
      setProgress(payload.percent, { indeterminate: false });
    } else if (
      payload.phase !== 'downloading' &&
      payload.phase !== 'installing' &&
      payload.phase !== 'updatedone'
    ) {
      setProgress(null);
    }
  }

  if (api && typeof api.onStatus === 'function') {
    api.onStatus(applyPayload);
  } else {
    applyPayload({ phase: 'launching', message: 'Запуск…' });
  }
})();
