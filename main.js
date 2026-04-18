'use strict';

/**
 * Точка входа: только жизненный цикл приложения и связывание двух слоёв.
 * — `updater-splash.js`: сплэш + electron-updater (можно править отдельно от UI).
 * — `application-main.js`: главное окно, профили, IPC интерфейса.
 */
const startupTrace = require('./startup-trace');
const instanceLock = require('./electron-instance-lock');
startupTrace.trace('main.js: bootstrap');

const { app, BrowserWindow, Menu } = require('electron');
const state = require('./electron-app-state');
const updaterSplash = require('./updater-splash');
const applicationMain = require('./application-main');

updaterSplash.init({
  state,
  createMainWindow: () => {
    applicationMain.createMainWindow();
  },
  notifyUpdatesFlowResumedMain: () => {
    applicationMain.notifyUpdatesFlowResumedMain();
  },
});

applicationMain.init({
  state,
  splashApi: updaterSplash.getMainWindowSplashHelpers(),
  sanitizeNetworkErrorMessage: updaterSplash.sanitizeNetworkErrorMessage,
});

if (!instanceLock.requestSingleInstanceWithReplace(app)) {
  startupTrace.trace(
    'main: single-instance lock NOT acquired после попытки замены. Лог: ' + startupTrace.traceFile(),
  );
  try {
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'Deadlock Tweaker',
      'Не удалось занять единственный экземпляр (после попытки завершить предыдущий процесс).\n\n' +
        'Закройте приложение вручную в Диспетчере задач и повторите запуск.\n\n' +
        'Диагностика: ' +
        startupTrace.traceFile(),
    );
  } catch {
    /* ignore */
  }
  app.quit();
} else {
  startupTrace.trace('main: single-instance lock OK');
  instanceLock.writeMainPidFile();
  app.on('second-instance', () => {
    updaterSplash.focusExistingWindow();
  });

  app.on('will-quit', () => {
    instanceLock.clearMainPidFile();
  });

  app
    .whenReady()
    .then(() => {
      startupTrace.trace('main: app.whenReady');
      try {
        if (process.platform !== 'darwin' && typeof app.setQuitOnLastWindowClosed === 'function') {
          app.setQuitOnLastWindowClosed(true);
        }
      } catch {
        /* ignore */
      }
      try {
        if (process.platform === 'win32') {
          try {
            Menu.setApplicationMenu(null);
          } catch {
            /* ignore */
          }
        }
        applicationMain.registerAppIpc();
        startupTrace.trace('main: registerAppIpc OK');
        updaterSplash.registerUpdaterIpc();
        startupTrace.trace('main: registerUpdaterIpc OK');
        updaterSplash.startSplashThenMain();
        startupTrace.trace('main: startSplashThenMain returned');
      } catch (err) {
        startupTrace.traceErr('main: startup init failed', err);
        try {
          console.error('[DLTweaker] startup init failed:', err);
        } catch {
          /* ignore */
        }
        try {
          const { dialog } = require('electron');
          dialog.showErrorBox('Deadlock Tweaker', `Ошибка запуска:\n${err && err.message ? String(err.message) : String(err)}`);
        } catch {
          /* ignore */
        }
      }
    })
    .catch((err) => {
      startupTrace.traceErr('main: whenReady rejected', err);
      try {
        console.error('[DLTweaker] whenReady failed:', err);
      } catch {
        /* ignore */
      }
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      setTimeout(() => {
        try {
          if (BrowserWindow.getAllWindows().length > 0) return;
          app.quit();
        } catch {
          /* ignore */
        }
      }, 250);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      updaterSplash.startSplashThenMain();
    } else {
      updaterSplash.focusExistingWindow();
    }
  });
}
