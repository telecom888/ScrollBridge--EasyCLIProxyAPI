const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bridge', {
  invoke: (action, payload) => ipcRenderer.invoke('bridge', action, payload),
  onUpdate: callback => { const handler = (_, state) => callback(state); ipcRenderer.on('update', handler); return () => ipcRenderer.removeListener('update', handler); }
});
