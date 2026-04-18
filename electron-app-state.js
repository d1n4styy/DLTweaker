'use strict';

/**
 * Общее состояние процесса Electron (окна и флаги).
 * Сплэш/updater и основное приложение читают одни и те же ссылки — без дублирования глобалов в двух файлах.
 */
module.exports = {
  splashWin: null,
  mainWin: null,
  splashProgrammaticClose: false,
  splashUserAborted: false,
  settingsSplashUpdateBusy: false,
  mainWinSplashCloseScheduled: false,
  /** @type {Promise<unknown> | null} фоновая подгрузка quick-patch на этапе сплэша */
  splashQuickPatchPromise: null,
  /** @type {Array<[string, (...args: any[]) => void]>} */
  updaterListeners: [],
};
