import { BrowserWindow } from 'electron'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ev = (wc: Electron.WebContents, code: string, g = false) => wc.executeJavaScript(code, g)
export async function runSuite(c: any) {
  const main = c.mainWin.webContents
  await ev(main, `window.__spike.openChild({provider:true,workarounds:true,css:'link',handleClose:true})`, true)
  await sleep(800)
  const ch: BrowserWindow = c.getChild()
  const wc = ch.webContents
  ch.focus(); wc.focus(); await sleep(300)
  const click = async (x: number, y: number) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(500)
  }
  const tree = () => ev(wc, `(()=>{const f=(e,d)=>d>3?'':'  '.repeat(d)+e.tagName+(e.id?'#'+e.id:'')+(e.getAttribute('aria-hidden')?' aria-hidden='+e.getAttribute('aria-hidden'):'')+(e.hasAttribute('inert')?' inert':'')+'\\n'+Array.from(e.children).map(k=>f(k,d+1)).join('');return f(document.body,0)})()`)
  const key = async (k: string) => { wc.sendInputEvent({ type: 'keyDown', keyCode: k }); wc.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(400) }
  const st = async (l: string) => console.log(l, await ev(wc, `JSON.stringify({active:document.activeElement.id||document.activeElement.tagName,hasFocus:document.hasFocus(),pop:!!document.querySelector('[data-testid=popover]'),tip:!!document.querySelector('[data-testid=tooltip]'),tipMain:!!document.documentElement.ownerDocument.defaultView.opener?.document.querySelector('[data-testid=tooltip]')})`))
  ch.focus(); wc.focus(); await sleep(300)
  await click(450, 480)
  for (let i = 0; i < 6; i++) { wc.sendInputEvent({ type: 'mouseMove', x: 40 + i, y: 224 + (i % 2) }); await sleep(150) }
  await sleep(1000)
  console.log('tip rect', await ev(wc, `(()=>{const t=document.querySelector('[data-testid=tooltip]');if(!t)return 'none';const r=t.getBoundingClientRect();return JSON.stringify({r:[r.x,r.y,r.width,r.height],style:t.getAttribute('style'),place:t.getAttribute('data-placement'),parent:t.parentElement.outerHTML.slice(0,200)})})()`))
  console.log('trigger', await ev(wc, `JSON.stringify(document.querySelector('#tip-trigger').getBoundingClientRect())`))
}
