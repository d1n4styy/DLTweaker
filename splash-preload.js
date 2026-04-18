const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashAPI', {
  onStatus: (callback) => {
    const listener = (_event, payload) => {
      if (typeof callback === 'function') callback(payload);
    };
    ipcRenderer.on('splash-status', listener);
    return () => ipcRenderer.removeListener('splash-status', listener);
  },
});
