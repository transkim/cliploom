const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cliploomDesktop', {
  platform: process.platform,
  saveFile: (f) => ipcRenderer.invoke('cliploom:save', f),
  fetchMedia: (url) => ipcRenderer.invoke('cliploom:fetch', url),
  http: (req) => ipcRenderer.invoke('cliploom:http', req),
  openExternal: (url) => ipcRenderer.invoke('cliploom:open', url),
});
