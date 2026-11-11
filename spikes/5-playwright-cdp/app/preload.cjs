const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('spike', {
  openBrowserWindow: () => ipcRenderer.invoke('open-browser-window'),
  quit: () => ipcRenderer.invoke('quit-app'),
})
