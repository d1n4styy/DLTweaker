const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  profilesLoad: () => ipcRenderer.invoke('profiles-load'),
  profilesSave: (data) => ipcRenderer.invoke('profiles-save', data),
  getGameProcessStatus: () => ipcRenderer.invoke('game-process-status'),
  getAppVersion: () => ipcRenderer.invoke('app-get-version'),
  checkUpdatesOnly: () => ipcRenderer.invoke('updates-check-only'),
  downloadUpdatesInstall: () => ipcRenderer.invoke('updates-download-install'),
  onSettingsUpdateDownloadProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on('settings-update-download-progress', listener);
    return () => ipcRenderer.removeListener('settings-update-download-progress', listener);
  },
  fetchReleaseNotes: () => ipcRenderer.invoke('updates-release-notes'),
  openExternalGithub: (url) => ipcRenderer.invoke('open-external-url', url),
  quickPatchApply: () => ipcRenderer.invoke('quick-patch-apply'),
  quickPatchGetCss: () => ipcRenderer.invoke('quick-patch-get-css'),
  onQuickPatchUpdated: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => {
      callback();
    };
    ipcRenderer.on('quick-patch-updated', listener);
    return () => ipcRenderer.removeListener('quick-patch-updated', listener);
  },
});
