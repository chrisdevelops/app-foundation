// Turns out/results.json into a pass/fail table. Pass criteria are defined here, in one place.
import { readFileSync, writeFileSync } from 'node:fs'
const r = JSON.parse(readFileSync('out/results.json', 'utf8'))
const gap = (a, b) => {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0)
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0)
  return Math.hypot(dx, dy)
}
const lines = []
for (const mode of Object.keys(r.modes)) {
  lines.push(`\n## ${mode}`)
  lines.push('| overlay | in child doc | not in main doc | positioned | focus in | Esc closes | focus back | outside click closes | hides child outside | main doc not hidden |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const [id, c] of Object.entries(r.modes[mode])) {
    if (id === 'keyboard') { lines.push(`\nkeyboard: ${JSON.stringify(c)}`); continue }
    const o = c.open
    const isTip = id === 'tooltip'
    const pos = !o.ovRect ? false
      : id === 'dialog' ? Math.abs(o.ovRect.x + o.ovRect.w / 2 - o.vp.w / 2) < 30 && Math.abs(o.ovRect.y + o.ovRect.h / 2 - o.vp.h / 2) < 30
      : id === 'context-menu' ? Math.hypot(o.ovRect.x - o.clickPt.x, o.ovRect.y - o.clickPt.y) < 20
      : gap(o.ovRect, o.trRect) <= 20
    const e = c.afterEscapeOrLeave
    const cells = [
      o.inChild, !o.inMain, pos && o.inChild,
      isTip ? 'n/a' : o.focus.inOverlay,
      !e.inChild && !e.inMain,
      isTip ? 'n/a' : (!e.inChild && /^(pop-trigger|menu-trigger|dialog-trigger|ctx)$/.test(e.active ?? '')),
      isTip ? 'n/a (hover leave)' : (c.afterOutsideClick && !c.afterOutsideClick.inChild && !c.afterOutsideClick.inMain),
      isTip ? 'n/a' : o.hidden,
      isTip ? 'n/a' : !o.mainHidden,
    ]
    lines.push(`| ${id} | ${cells.map((v) => (v === true ? 'PASS' : v === false ? 'FAIL' : v)).join(' | ')} |`)
  }
}
const txt = lines.join('\n')
writeFileSync('out/table.md', txt)
console.log(txt)
