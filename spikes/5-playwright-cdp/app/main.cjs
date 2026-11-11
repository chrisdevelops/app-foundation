const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

const webPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  preload: path.join(__dirname, 'preload.cjs'),
}
function openWindow(file, title) {
  const w = new BrowserWindow({ width: 480, height: 360, title, webPreferences })
  void w.loadFile(path.join(__dirname, file))
  return w
}
app.whenReady().then(() => {
  ipcMain.handle('open-browser-window', () => { openWindow('child.html', 'Child via BrowserWindow'); return true })
  ipcMain.handle('quit-app', () => { setTimeout(() => app.quit(), 50); return true })
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: { webPreferences: { ...webPreferences } },
    }))
  })
  openWindow('index.html', 'Spike Main')
})
app.on('window-all-closed', () => app.quit())
