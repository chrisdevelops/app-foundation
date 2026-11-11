import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { runSuite as fullSuite } from './driver'
import { runSuite as debugSuite } from './debug'
const runSuite = process.env.SPIKE_DEBUG ? debugSuite : fullSuite

const baseline = { contextIsolation: true, sandbox: true, nodeIntegration: false } as const
const log: string[] = []
const out = path.join(__dirname, '..', 'out')
fs.mkdirSync(out, { recursive: true })
const note = (s: string) => { log.push(s); console.log('[main]', s) }

let child: BrowserWindow | null = null
let openHandlerCalls: any[] = []

app.whenReady().then(async () => {
  const mainWin = new BrowserWindow({ width: 900, height: 700, show: true, webPreferences: { ...baseline } })
  mainWin.webContents.setWindowOpenHandler((details) => {
    openHandlerCalls.push({ url: details.url, frameName: details.frameName, disposition: details.disposition })
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520, height: 520, x: 960, y: 80,
        webPreferences: { ...baseline },
      },
    }
  })
  mainWin.webContents.on('console-message', (e) => note(`main-console[${e.level}] ${e.message}`))
  mainWin.webContents.on('did-create-window', (w) => {
    child = w
    w.webContents.on('console-message', (e) => note(`child-console[${e.level}] ${e.message}`))
    w.on('closed', () => { note('child closed'); child = null })
  })
  await mainWin.loadFile(path.join(__dirname, 'index.html'))
  await new Promise((r) => setTimeout(r, 500))
  try {
    await runSuite({
      mainWin, getChild: () => child, note, out,
      handlerCalls: () => openHandlerCalls,
      resetHandlerCalls: () => { openHandlerCalls = [] },
    })
  } catch (e) {
    note('SUITE ERROR ' + String((e as Error).stack))
  }
  fs.writeFileSync(path.join(out, 'main-log.txt'), log.join('\n'))
  app.quit()
})
