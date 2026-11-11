import { chromium } from 'playwright-core'
import { startApp, waitForEndpoint, stopApp } from './harness'

const log = (k: string, v: unknown) => console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)

async function main() {
  const exe = process.argv[2]!
  const app = startApp(9336, { exe })
  try {
    const ver = await waitForEndpoint(9336, 10000)
    log('packaged.endpoint', ver.Browser)
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9336')
    const ctx = browser.contexts()[0]!
    await new Promise((r) => setTimeout(r, 500))
    const page = ctx.pages()[0]!
    log('packaged.title', await page.title())
    await page.click('#inc')
    log('packaged.count', await page.textContent('#count'))
    const w = ctx.waitForEvent('page', { timeout: 5000 })
    await page.click('#open-bw')
    const c = await w
    await c.waitForLoadState('domcontentloaded')
    await c.click('#go')
    log('packaged.child', await c.textContent('#out'))
    await browser.close()
  } catch (e) {
    log('packaged.FAIL', String(e instanceof Error ? e.message : e).split('\n')[0])
    log('packaged.output', app.output().trim().split('\n').slice(0, 5))
  } finally {
    log('packaged.orphans', await stopApp(app))
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1) })
