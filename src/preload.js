const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cliploomDesktop', {
  platform: process.platform,
  saveFile: (f) => ipcRenderer.invoke('cliploom:save', f),
  fetchMedia: (url) => ipcRenderer.invoke('cliploom:fetch', url),
  openExternal: (url) => ipcRenderer.invoke('cliploom:open', url),
});
