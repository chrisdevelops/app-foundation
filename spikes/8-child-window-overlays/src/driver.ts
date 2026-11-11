import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

type Ctx = {
  mainWin: BrowserWindow
  getChild: () => BrowserWindow | null
  note: (s: string) => void
  out: string
  handlerCalls: () => any[]
  resetHandlerCalls: () => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ev = (wc: Electron.WebContents, code: string, gesture = false) => wc.executeJavaScript(code, gesture)

export async function runSuite(c: Ctx) {
  const results: any = { versions: {}, modes: {}, extra: {} }
  results.versions = {
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: process.platform, arch: process.arch,
  }
  const main = c.mainWin.webContents

  async function openChild(opts: any, gesture = true) {
    c.resetHandlerCalls()
    const before = c.getChild()
    const info = await ev(main, `window.__spike.openChild(${JSON.stringify(opts)})`, gesture)
    await sleep(800)
    const ch = c.getChild()
    return { info, ch, created: ch !== before && !!ch }
  }
  async function closeChild() {
    const ch = c.getChild()
    if (ch) { ch.close(); await sleep(600) }
  }

  const click = async (wc: Electron.WebContents, x: number, y: number, button: 'left' | 'right' = 'left') => {
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 })
    await sleep(350)
  }
  const key = async (wc: Electron.WebContents, keyCode: string) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode.length === 1) wc.sendInputEvent({ type: 'char', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(350)
  }
  const rectOf = (wc: Electron.WebContents, sel: string) =>
    ev(wc, `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`)
  const center = (r: any) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) })

  // ---- overlay matrix ----
  const overlays = [
    { id: 'popover', tid: 'popover', trigger: '#pop-trigger', open: 'click', hides: true },
    { id: 'menu', tid: 'menu', trigger: '#menu-trigger', open: 'click', hides: true },
    { id: 'dialog', tid: 'dialog', trigger: '#dialog-trigger', open: 'click', hides: true },
    { id: 'tooltip', tid: 'tooltip', trigger: '#tip-trigger', open: 'hover', hides: false },
    { id: 'context-menu', tid: 'ctx-menu', trigger: '#ctx', open: 'right-click', hides: true },
  ]

  async function snap(chWc: Electron.WebContents, o: any, clickPt?: any) {
    const inChild = await ev(chWc, `!!document.querySelector('[data-testid=${o.tid}]')`)
    const inMain = await ev(main, `!!document.querySelector('[data-testid=${o.tid}]')`)
    const doc = inChild ? chWc : inMain ? main : null
    const ovRect = doc ? await rectOf(doc, `[data-testid=${o.tid}]`) : null
    const trRect = await rectOf(chWc, o.trigger)
    const vp = await ev(chWc, `({w:innerWidth,h:innerHeight})`)
    const focus = await ev(chWc, `(()=>{const ov=document.querySelector('[data-testid=${o.tid}]');const a=document.activeElement;return {active:a&&(a.id||a.tagName),inOverlay:!!(ov&&a&&ov.contains(a)),docHasFocus:document.hasFocus()}})()`)
    const hidden = await ev(chWc, `(()=>{const e=document.querySelector('#outside');return !!(e&&e.closest('[aria-hidden=true],[inert]'))})()`)
    const mainHidden = await ev(main, `!!document.body.closest('[aria-hidden=true],[inert]') || !!document.querySelector('#root[aria-hidden=true], #root [aria-hidden=true], #root[inert]')`)
    const outsideBtnHidden = await ev(chWc, `(()=>{const e=document.querySelector('#outside-btn');return !!(e&&e.closest('[aria-hidden=true],[inert]'))})()`)
    return { inChild, inMain, ovRect, trRect, vp, focus, hidden, mainHidden, outsideBtnHidden, clickPt }
  }
  const gap = (a: any, b: any) => {
    const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0)
    const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0)
    return Math.round(Math.hypot(dx, dy))
  }

  async function openOverlay(chWc: Electron.WebContents, o: any) {
    const tr = await rectOf(chWc, o.trigger)
    let pt = center(tr)
    if (o.open === 'right-click') { pt = { x: Math.round(tr.x + 40), y: Math.round(tr.y + 20) }; await click(chWc, pt.x, pt.y, 'right') }
    else if (o.open === 'hover') { chWc.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 }); await sleep(100); chWc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y }); await sleep(100); chWc.sendInputEvent({ type: 'mouseMove', x: pt.x + 1, y: pt.y }); await sleep(500) }
    else await click(chWc, pt.x, pt.y)
    return pt
  }

  for (const mode of ['provider', 'control', 'workarounds']) {
    const { info, ch, created } = await openChild({ provider: mode !== 'control', workarounds: mode === 'workarounds', css: 'link', handleClose: true })
    c.note(`mode=${mode} open info=${JSON.stringify(info)} created=${created} handlerCalls=${JSON.stringify(c.handlerCalls())}`)
    if (!ch) { results.modes[mode] = { error: 'no child' }; continue }
    const chWc = ch.webContents
    ch.focus(); chWc.focus(); await sleep(400)
    if (mode === 'provider') {
      results.extra.openInfo = info
      results.extra.processIds = { main: main.getOSProcessId(), child: chWc.getOSProcessId() }
      results.extra.childWebPreferences = chWc.getLastWebPreferences ? chWc.getLastWebPreferences() : null
      results.extra.mainWebPreferences = main.getLastWebPreferences()
    }
    const m: any = {}
    for (const o of overlays) {
      const cell: any = {}
      ch.focus(); chWc.focus(); await sleep(250)
      if (o.open === 'hover') await click(chWc, 450, 480)
      // open
      const pt = await openOverlay(chWc, o)
      const s = await snap(chWc, o, pt)
      cell.open = s
      await chWc.capturePage().then((img) => fs.writeFileSync(path.join(c.out, `${mode}-${o.id}-child.png`), img.toPNG()))
      if (mode === 'control' && s.inMain) await c.mainWin.webContents.capturePage().then((img) => fs.writeFileSync(path.join(c.out, `${mode}-${o.id}-main.png`), img.toPNG()))
      // Escape
      if (o.open !== 'hover') await key(chWc, 'Escape'); else { chWc.sendInputEvent({ type: 'mouseMove', x: 400, y: 450 }); await sleep(500) }
      cell.afterEscapeOrLeave = {
        inChild: await ev(chWc, `!!document.querySelector('[data-testid=${o.tid}]')`),
        inMain: await ev(main, `!!document.querySelector('[data-testid=${o.tid}]')`),
        active: await ev(chWc, `document.activeElement&&(document.activeElement.id||document.activeElement.tagName)`),
        mainHiddenAfter: await ev(main, `!!document.body.closest('[aria-hidden=true],[inert]')`),
        hiddenAfter: await ev(chWc, `!!document.querySelector('#outside')?.closest('[aria-hidden=true],[inert]')`),
      }
      if (o.open !== 'hover') {
        // reopen and outside click
        await openOverlay(chWc, o)
        const out = o.id === 'dialog' ? { x: 10, y: 10 } : { x: 450, y: 480 }
        await click(chWc, out.x, out.y)
        cell.afterOutsideClick = {
          inChild: await ev(chWc, `!!document.querySelector('[data-testid=${o.tid}]')`),
          inMain: await ev(main, `!!document.querySelector('[data-testid=${o.tid}]')`),
          active: await ev(chWc, `document.activeElement&&(document.activeElement.id||document.activeElement.tagName)`),
        }
        // clean up if still open
        await key(chWc, 'Escape'); await key(main, 'Escape')
      }
      m[o.id] = cell
      await sleep(200)
    }
    // keyboard delegation
    await ev(main, `window.__hits.kbd=0`)
    const kr = await rectOf(chWc, '#kbd')
    await click(chWc, ...(Object.values(center(kr)) as [number, number]))
    await key(chWc, 'q'); await key(chWc, 'Down')
    m.keyboard = {
      reactKbdHits: await ev(main, `window.__hits.kbd`),
      lastKey: await ev(main, `window.__hits.lastKey`),
      inputValueInChild: await ev(chWc, `document.querySelector('#kbd').value`),
    }
    results.modes[mode] = m
    await closeChild()
  }

  // ---- stylesheets ----
  results.extra.css = {}
  for (const css of ['link', 'adopted', 'cssom', 'styletext', 'none']) {
    const { ch } = await openChild({ provider: true, css, handleClose: true })
    if (!ch) continue
    await sleep(300)
    const r = await ev(ch.webContents, `(()=>{const e=document.querySelector('#layer-probe');const cs=getComputedStyle(e);
      let inl='n/a';try{const s=document.createElement('script');s.textContent='window.__inl=1';document.head.appendChild(s);inl=String(window.__inl===1)}catch(x){inl=String(x)}
      return {color:cs.color,bg:cs.backgroundColor,sheets:document.styleSheets.length,inlineScriptRan:inl,cspMeta:!!document.querySelector('meta[http-equiv]')}})()`)
    results.extra.css[css] = r
    await closeChild()
  }

  // ---- user gesture ----
  results.extra.gesture = {}
  async function gestureCase(name: string, code: string, gesture: boolean) {
    c.resetHandlerCalls()
    const before = c.getChild()
    let ret: any
    try { ret = await ev(main, code, gesture) } catch (e) { ret = 'ERR ' + e }
    await sleep(1200)
    const ch = c.getChild()
    results.extra.gesture[name] = { returned: ret, handlerCalls: c.handlerCalls().length, windowCreated: !!ch && ch !== before }
    await closeChild()
  }
  await gestureCase('direct_no_gesture', `String(!!window.open('about:blank','g1'))`, false)
  await gestureCase('direct_with_gesture', `String(!!window.open('about:blank','g2'))`, true)
  await gestureCase('timer_no_gesture', `new Promise(r=>setTimeout(()=>r(String(!!window.open('about:blank','g3'))),100))`, false)
  await gestureCase('timer_after_gesture_2s', `new Promise(r=>setTimeout(()=>r(String(!!window.open('about:blank','g4'))),2000))`, true)
  // real click on button
  {
    c.resetHandlerCalls()
    const r = await rectOf(main, '#open-provider')
    main.focus()
    await click(main, ...(Object.values(center(r)) as [number, number]))
    await sleep(800)
    results.extra.gesture.real_click = { windowCreated: !!c.getChild(), handlerCalls: c.handlerCalls().length }
    await closeChild()
  }

  // ---- close while overlay open ----
  results.extra.closeWhileOpen = {}
  for (const handle of [true, false]) {
    const { ch } = await openChild({ provider: true, css: 'link', handleClose: handle })
    if (!ch) continue
    const chWc = ch.webContents
    ch.focus(); chWc.focus(); await sleep(300)
    const tr = await rectOf(chWc, '#menu-trigger')
    await click(chWc, ...(Object.values(center(tr)) as [number, number]))
    const openBefore = await ev(chWc, `!!document.querySelector('[data-testid=menu]')`)
    c.note(`--- closeWhileOpen handleClose=${handle} menuOpen=${openBefore}: closing`)
    ch.close()
    await sleep(1200)
    // is main still alive, can open another child?
    const alive = await ev(main, `1+1`)
    const mainBodyHiddenAfterClose = await ev(main, `document.body.getAttribute('aria-hidden')`)
    const again = await openChild({ provider: true, css: 'link', handleClose: true })
    const reopenedOk = !!again.ch && (await ev(again.ch.webContents, `!!document.querySelector('#outside-btn')`))
    results.extra.closeWhileOpen[`handleClose_${handle}`] = { openBefore, mainAlive: alive, mainBodyHiddenAfterClose, reopenedOk }
    c.note(`--- closeWhileOpen handleClose=${handle} done`)
    await closeChild()
    await ev(main, `location.reload()`).catch(() => {})
    await sleep(800)
  }

  fs.writeFileSync(path.join(c.out, 'results.json'), JSON.stringify(results, null, 2))
  c.note('RESULTS WRITTEN')
}
