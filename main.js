'use strict';

/**
 * Точка входа: только жизненный цикл приложения и связывание двух слоёв.
 * — `updater-splash.js`: сплэш + electron-updater (можно править отдельно от UI).
 * — `application-main.js`: главное окно, профили, IPC интерфейса.
 */
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    updaterSplash.focusExistingWindow();
  });

  app.whenReady().then(() => {
    if (process.platform !== 'darwin') {
      app.setQuitOnLastWindowClosed(true);
    }
    if (process.platform === 'win32') {
      try {
        Menu.setApplicationMenu(null);
      } catch {
        /* ignore */
      }
    }
    applicationMain.registerAppIpc();
    updaterSplash.registerUpdaterIpc();
    updaterSplash.startSplashThenMain();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      try {
        app.quit();
      } catch {
        /* ignore */
      }
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
