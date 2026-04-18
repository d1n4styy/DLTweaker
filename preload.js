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
  checkForUpdatesManual: () => ipcRenderer.invoke('updates-check-manual'),
});
