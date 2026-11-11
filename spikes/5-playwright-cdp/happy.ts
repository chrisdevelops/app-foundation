import { chromium, type Page } from 'playwright-core'
import { startApp, waitForEndpoint, stopApp } from './harness'

const PORT = 9333
const log = (k: string, v: unknown) => console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)

async function main() {
  const app = startApp(PORT)
  try {
    const ver = await waitForEndpoint(PORT)
    log('endpoint.Browser', ver.Browser)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
    log('playwright.browserVersion', browser.version())
    const ctx = browser.contexts()[0]!
    log('contexts', browser.contexts().length)
    await new Promise((r) => setTimeout(r, 500))
    log('pages.initial', await Promise.all(ctx.pages().map(async (p) => `${await p.title()} | ${p.url()}`)))
    const main = ctx.pages().find((p) => p.url().endsWith('index.html'))!
    log('main.title', await main.title())

    // click + DOM change
    await main.click('#inc')
    await main.click('#inc')
    log('count.after2clicks', await main.textContent('#count'))

    // security baseline visible from renderer
    log('main.renderer', await main.evaluate(() => ({ require: typeof (window as any).require, process: typeof (window as any).process, bridge: typeof (window as any).spike })))
    log('main.cspBlocksInline', await main.evaluate(() => { try { return eval('1+1') } catch (e) { return String(e).slice(0, 80) } }))

    // window.open child, opened after connect
    const pOpen = ctx.waitForEvent('page', { timeout: 5000 })
    await main.click('#open-wo')
    const c1: Page = await pOpen
    await c1.waitForLoadState('domcontentloaded')
    log('child.windowOpen.title', await c1.title())
    await c1.click('#go')
    log('child.windowOpen.out', await c1.textContent('#out'))

    // new BrowserWindow via IPC
    const pBw = ctx.waitForEvent('page', { timeout: 5000 })
    await main.click('#open-bw')
    const c2: Page = await pBw
    await c2.waitForLoadState('domcontentloaded')
    log('child.browserWindow.title', await c2.title())
    await c2.click('#go')
    log('child.browserWindow.out', await c2.textContent('#out'))
    log('pages.final', ctx.pages().length)

    // close child windows from CDP and check list
    await c1.close()
    log('pages.afterCloseOne', ctx.pages().length)

    // browser.close() on connectOverCDP: disconnects only? check app still alive
    await browser.close()
    await new Promise((r) => setTimeout(r, 800))
    log('appAliveAfterBrowserClose', app.child.exitCode === null)
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((x) => x.ok).catch(() => false)
    log('endpointAliveAfterBrowserClose', r)
  } finally {
    const orphans = await stopApp(app)
    log('orphansAfterStop', orphans)
    log('appOutput', app.output().trim().split('\n').slice(0, 6).join(' // '))
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1) })
