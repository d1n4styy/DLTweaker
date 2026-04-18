(function () {
  const api = window.splashAPI;
  const line = document.getElementById('splash-line');
  const sub = document.getElementById('splash-sub');
  const progressWrap = document.getElementById('splash-progress-wrap');
  const progressFill = document.getElementById('splash-progress-fill');

  function setProgress(pct) {
    if (pct == null || Number.isNaN(pct)) {
      progressWrap.hidden = true;
      progressFill.style.width = '0%';
      return;
    }
    progressWrap.hidden = false;
    const v = Math.max(0, Math.min(100, pct));
    progressFill.style.width = `${v}%`;
  }

  function applyPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (line && payload.message) line.textContent = payload.message;
    if (sub) {
      const hints = {
        checking: 'Подключение к серверу обновлений',
        available: 'Скоро начнётся загрузка',
        downloading: 'Не закрывайте это окно',
        installing: 'Приложение перезапустится',
        uptodate: 'Переход к основному окну',
        launching: 'Почти готово',
        offline: 'Обновления недоступны, открываем приложение',
        dev: 'Сборка разработчика',
      };
      sub.textContent = hints[payload.phase] || '';
    }
    if (payload.phase === 'downloading' && typeof payload.percent === 'number') {
      setProgress(payload.percent);
    } else if (payload.phase !== 'downloading') {
      setProgress(null);
    }
  }

  if (api && typeof api.onStatus === 'function') {
    api.onStatus(applyPayload);
  } else {
    applyPayload({ phase: 'launching', message: 'Запуск…' });
  }
})();
