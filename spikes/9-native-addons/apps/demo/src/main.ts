import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { greeting } from '@spike/greeting'
import { runPty, runSharp, runSqlite } from './native-addons'

// Spike #6 hang probe: a top-level require() of a module that is missing from the package.
if (process.env.SPIKE_STATIC_PROBE === '1') require('better-sqlite3')

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined
declare const MAIN_WINDOW_VITE_NAME: string

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 600,
    height: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  const rendererLogs: string[] = []
  win.webContents.on('console-message', (event) => {
    rendererLogs.push(event.message)
  })
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    await win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`))
  }
  const reportPath = process.env.SPIKE_REPORT
  if (reportPath) {
    await new Promise((r) => setTimeout(r, 1500))
    const prefs = win.webContents.getLastWebPreferences()
    const addons: Record<string, unknown> = {}
    for (const [name, fn] of Object.entries({ sqlite: runSqlite, sharp: runSharp, pty: runPty })) {
      try {
        addons[name] = { ok: true, result: await fn() }
      } catch (e) {
        addons[name] = { ok: false, error: String((e as Error).stack ?? e) }
      }
    }
    const marker = await win.webContents.executeJavaScript('document.getElementById("marker").textContent')
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          mainGreeting: greeting('main'),
          packaged: app.isPackaged,
          devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL ?? null,
          contextIsolation: prefs.contextIsolation,
          sandbox: prefs.sandbox,
          nodeIntegration: prefs.nodeIntegration,
          marker,
          addons,
          loadedNativeFiles: (process.report.getReport() as unknown as { sharedObjects: string[] }).sharedObjects.filter((s) => /\.node$|libvips|spawn-helper/.test(s)),
          asarIntegrityNote: 'see fuses read-back',
          resourcesPath: process.resourcesPath,
          rendererLogs,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
        },
        null,
        2,
      ),
    )
    if (process.env.SPIKE_QUIT === '1') app.quit()
    else {
      // dev-run proof: log the marker every second, with the main process pid
      setInterval(async () => {
        const m = await win.webContents.executeJavaScript('document.getElementById("marker").textContent')
        console.log(`SPIKE_POLL pid=${process.pid} marker=${m}`)
      }, 1000)
    }
  }
})

app.on('window-all-closed', () => app.quit())
