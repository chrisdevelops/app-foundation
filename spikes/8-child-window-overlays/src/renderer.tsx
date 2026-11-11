import React, { useRef, useState, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { UNSAFE_PortalProvider, ariaHideOutside } from '@react-aria/overlays'
// PRIVATE path (not documented as public API): used only in the 'workarounds' mode.
import { addWindowFocusTracking } from 'react-aria/private/interactions/useFocusVisible'
import {
  Button, Dialog, DialogTrigger, Heading, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover,
  Tooltip, TooltipTrigger,
} from 'react-aria-components'

type CssMode = 'link' | 'adopted' | 'cssom' | 'styletext' | 'none'
type OpenOpts = { provider: boolean; workarounds?: boolean; css: CssMode; handleClose: boolean; windowFeatures?: string; target?: string }

function copyStyles(from: Document, to: Document, mode: CssMode) {
  if (mode === 'none') return
  if (mode === 'link') {
    for (const l of Array.from(from.querySelectorAll('link[rel=stylesheet]'))) {
      const n = to.createElement('link')
      n.rel = 'stylesheet'
      n.href = (l as HTMLLinkElement).href // absolute file:// URL
      to.head.appendChild(n)
    }
    return
  }
  if (mode === 'adopted') {
    const W = (to.defaultView as any)
    for (const sheet of Array.from(from.styleSheets)) {
      try {
        const cs = new W.CSSStyleSheet() // constructed in the child realm
        cs.replaceSync(Array.from(sheet.cssRules).map((r) => r.cssText).join('\n'))
        to.adoptedStyleSheets = [...to.adoptedStyleSheets, cs]
      } catch (e) { console.error('adopted failed: ' + e) }
    }
    return
  }
  for (const sheet of Array.from(from.styleSheets)) {
    const style = to.createElement('style')
    if (mode === 'styletext') {
      style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n')
      to.head.appendChild(style)
    } else if (mode === 'cssom') {
      to.head.appendChild(style)
      const target = style.sheet
      if (!target) { console.error('cssom: <style>.sheet is null in child (CSP blocked the style element)'); continue }
      for (const r of Array.from(sheet.cssRules)) target.insertRule(r.cssText, target.cssRules.length)
    }
  }
}

const logViolation = (where: string) => (e: any) =>
  console.log(`CSPVIOLATION[${where}] directive=${e.violatedDirective} blocked=${e.blockedURI} file=${e.sourceFile}:${e.lineNumber} sample=${JSON.stringify(e.sample)}`)
document.addEventListener('securitypolicyviolation', logViolation('main'))
// Workaround guard, rendered INSIDE each overlay. Fixes: (1) RAC hides the opener's document.body
// instead of the child's; (2) focus is not returned to the trigger in the child document.
function ChildOverlayGuard({ fix }: { fix: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (!fix || !ref.current) return
    const doc = ref.current.ownerDocument
    const prev = doc.activeElement as HTMLElement | null
    let top: HTMLElement = ref.current
    while (top.parentElement && top.parentElement.id !== 'portal-root') top = top.parentElement
    const undoHide = ariaHideOutside([top], { root: doc.body })
    const mainBody = document.body
    const revert = () => { mainBody.removeAttribute('aria-hidden'); mainBody.removeAttribute('inert') }
    const mo = new MutationObserver(revert)
    mo.observe(mainBody, { attributes: true, attributeFilter: ['aria-hidden', 'inert'] })
    return () => {
      mo.disconnect(); undoHide()
      queueMicrotask(() => { if (prev?.isConnected && (doc.activeElement === doc.body || !doc.activeElement)) prev.focus() })
    }
  }, [fix])
  return <span ref={ref} hidden data-guard />
}

const hits = { kbd: 0, lastKey: '', ctxOpen: 0 }
;(window as any).__hits = hits

function ChildContent({ fix }: { fix: boolean }) {
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  return (
    <div id="child-root" data-contrast="normal">
      <div id="outside">
        <p className="layer-probe" id="layer-probe">layer probe</p>
        <input id="kbd" aria-label="kbd" onKeyDown={(e) => { hits.kbd++; hits.lastKey = e.key }} />
        <div className="row"><Button id="outside-btn">outside button</Button></div>
        <div className="row">
          <DialogTrigger>
            <Button id="pop-trigger">Popover</Button>
            <Popover data-testid="popover" className="popover">
              <Dialog aria-label="pop"><ChildOverlayGuard fix={fix} /><p>popover body</p><Button id="pop-inner">inner</Button></Dialog>
            </Popover>
          </DialogTrigger>
        </div>
        <div className="row">
          <MenuTrigger>
            <Button id="menu-trigger">Menu</Button>
            <Popover data-testid="menu" className="popover">
              <ChildOverlayGuard fix={fix} />
              <Menu className="menu" aria-label="m">
                <MenuItem className="menuitem" id="a">Alpha</MenuItem>
                <MenuItem className="menuitem" id="b">Beta</MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
        </div>
        <div className="row">
          <DialogTrigger>
            <Button id="dialog-trigger">Dialog</Button>
            <ModalOverlay data-testid="dialog-underlay" className="underlay" isDismissable>
              <Modal data-testid="dialog">
                <Dialog className="dialog"><ChildOverlayGuard fix={fix} /><Heading slot="title">Modal</Heading><Button slot="close" id="dialog-close">close</Button></Dialog>
              </Modal>
            </ModalOverlay>
          </DialogTrigger>
        </div>
        <div className="row">
          <TooltipTrigger delay={0} closeDelay={0}>
            <Button id="tip-trigger">Tooltip</Button>
            <Tooltip data-testid="tooltip" className="tooltip" placement={fix ? 'bottom' : 'top'}>tip text</Tooltip>
          </TooltipTrigger>
        </div>
        <div className="row">
          <div id="ctx" className="ctx" tabIndex={0}
            onContextMenu={(e) => { e.preventDefault(); hits.ctxOpen++; setCtx({ x: e.clientX, y: e.clientY }) }}>
            right-click here
          </div>
          <span ref={anchor} id="ctx-anchor" style={{ position: 'fixed', left: ctx?.x ?? 0, top: ctx?.y ?? 0, width: 0, height: 0 }} />
          <Popover triggerRef={anchor} isOpen={!!ctx} onOpenChange={(o) => { if (!o) setCtx(null) }}
            data-testid="ctx-menu" className="popover" placement="bottom start">
            <ChildOverlayGuard fix={fix} />
            <Menu className="menu" aria-label="ctx" autoFocus="first" onAction={() => setCtx(null)}>
              <MenuItem className="menuitem" id="c1">Copy</MenuItem>
              <MenuItem className="menuitem" id="c2">Paste</MenuItem>
            </Menu>
          </Popover>
        </div>
      </div>
    </div>
  )
}

type Entry = { win: Window; container: HTMLElement; provider: boolean; fix: boolean }

function App() {
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [mainTick, setMainTick] = useState(0)

  useEffect(() => {
    ;(window as any).__spike = {
      openChild(opts: OpenOpts) {
        const name = opts.target ?? 'child-' + Date.now()
        const w = window.open('about:blank', name, opts.windowFeatures)
        if (!w) return { opened: false }
        const info: any = { opened: true }
        try {
          info.sameDocAccess = typeof w.document.body === 'object' && w.document.body !== null
          info.childLocation = w.location.href
          info.childOrigin = w.origin
          info.openerOrigin = window.origin
          info.crossRealm = w.document !== document
        } catch (e) { info.sameDocAccess = false; info.error = String(e) }
        if (!info.sameDocAccess) return info
        w.document.addEventListener('securitypolicyviolation', logViolation('child'))
        if (opts.workarounds) addWindowFocusTracking(w.document.body)
        copyStyles(document, w.document, opts.css)
        const container = w.document.createElement('div')
        container.id = 'portal-root'
        w.document.body.appendChild(container)
        if (opts.handleClose) w.addEventListener('pagehide', () => {
          console.log('pagehide in child -> unmount portal')
          setEntries((p) => { const n = { ...p }; delete n[name]; return n })
        })
        setEntries((p) => ({ ...p, [name]: { win: w, container, provider: opts.provider, fix: !!opts.workarounds } }))
        info.name = name
        return info
      },
      closeChildFromOpener(name: string) { const e = entries[name]; e?.win.close() },
      bumpMain: () => setMainTick((t) => t + 1),
    }
  })

  return (
    <div id="main-content">
      <h1>Main window ({mainTick})</h1>
      <Button id="open-provider" onPress={() => (window as any).__spike.openChild({ provider: true, css: 'link', handleClose: true })}>
        Open child window
      </Button>
      <div style={{ marginTop: 20 }}>
        <TooltipTrigger delay={0} closeDelay={0}>
          <Button id="main-tip">Main tooltip</Button>
          <Tooltip data-testid="main-tooltip" className="tooltip">main tip</Tooltip>
        </TooltipTrigger>
      </div>
      {Object.entries(entries).map(([name, e]) =>
        createPortal(
          e.provider ? (
            <UNSAFE_PortalProvider getContainer={() => e.container}><ChildContent fix={e.fix} /></UNSAFE_PortalProvider>
          ) : <ChildContent fix={e.fix} />,
          e.container, name))}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
