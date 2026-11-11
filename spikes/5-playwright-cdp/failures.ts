import { chromium } from 'playwright-core'
import { startApp, waitForEndpoint, stopApp, orphanPids } from './harness'

const log = (k: string, v: unknown) => console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
const msg = (e: unknown) => String(e instanceof Error ? e.message : e)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 1. app not started
  await chromium.connectOverCDP('http://127.0.0.1:9555', { timeout: 3000 }).catch((e) => log('F1.notStarted', msg(e)))

  // 2. wrong port
  const a = startApp(9333)
  await waitForEndpoint(9333)
  await chromium.connectOverCDP('http://127.0.0.1:9334', { timeout: 3000 }).catch((e) => log('F2.wrongPort', msg(e)))

  // 3. port already in use: second app on the same port
  const b = startApp(9333)
  await sleep(4000)
  log('F3.second.alive', b.child.exitCode === null)
  log('F3.second.output', b.output().trim().split('\n').filter((l) => /9333|remote|bind|address|DevTools/i.test(l)))
  const ver = await fetch('http://127.0.0.1:9333/json/version').then((r) => r.json()).catch((e) => msg(e))
  log('F3.endpoint.ws', (ver as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? ver)
  log('F3.firstApp.output', a.output().includes('9333') ? 'first app owns 9333' : 'first app silent')
  const orphB = await stopApp(b)
  log('F3.second.orphans', orphB)

  // 4. app quits during a test
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts()[0]!.pages()[0]!
  let disconnected = false
  browser.on('disconnected', () => { disconnected = true })
  await page.click('#quit', { noWaitAfter: true }).catch((e) => log('F4.clickQuit', msg(e)))
  await sleep(1500)
  log('F4.disconnectedEvent', disconnected)
  log('F4.appExited', a.child.exitCode)
  await page.title().catch((e) => log('F4.pageTitleAfterQuit', msg(e).split('\n')[0]))
  await page.click('#inc', { timeout: 2000 }).catch((e) => log('F4.clickAfterQuit', msg(e).split('\n')[0]))
  log('F4.orphans', orphanPids(a.userDataDir))

  // 5. graceful close through CDP Browser.close
  const c = startApp(9335)
  await waitForEndpoint(9335)
  const br = await chromium.connectOverCDP('http://127.0.0.1:9335')
  const s = await br.newBrowserCDPSession()
  await s.send('Browser.close').catch((e) => log('F5.browserClose.err', msg(e).split('\n')[0]))
  await sleep(2000)
  log('F5.exitCodeAfterBrowserClose', c.child.exitCode)
  log('F5.orphans', orphanPids(c.userDataDir))
  log('F5.cleanup', await stopApp(c))
  await stopApp(a)
}
main().catch((e) => { console.error('FAIL', e); process.exit(1) })
