# Spike 8: React Aria overlays in torn-off child windows

Branch `spike/8-child-window-overlays` (throwaway). Code: `spikes/8-child-window-overlays/`. Evidence: `spikes/8-child-window-overlays/out/` (`results.json`, `table.md`, `run.log`, 15 screenshots).

## Question

Do React Aria overlays (Popover, Menu, Dialog, Tooltip, context menu) work in a `window.open` child window rendered through `createPortal` from the main React tree, with the security baseline on and `UNSAFE_PortalProvider` pointing at the child document?

## Answer: go-with-changes (confidence: medium-high, macOS only)

Overlays render in the child document, position (bottom, right, centred), take focus, close on Escape and outside click. But `UNSAFE_PortalProvider` alone is not enough: four cross-document defects remain. The baseline is not weakened. Fixes 1 to 3 need a private React Aria path or an internals-dependent hack.

## Versions and platform

Electron 45.3.0 (Chrome 156.0.8078.96, Node 24.22.2), React 19.3.1, react-aria-components 1.22.1, react-aria 3.53.1, @react-aria/overlays 3.32.1, esbuild 0.28.2, host Node v24.18.0, pnpm 11.13.1, macOS 26.6.2 arm64. Windows and Linux: **not verified** (no primary source consulted).

## Facts

- **Baseline and handler:** both windows run `contextIsolation: true, sandbox: true, nodeIntegration: false` (confirmed with `getLastWebPreferences()`), CSP meta `default-src 'self'; script-src 'self'; style-src 'self'`. `setWindowOpenHandler` returns `{action:'allow', overrideBrowserWindowOptions:{webPreferences:{...baseline}}}`. Nothing is weakened. Open `about:blank` (same origin `file://`).
- **Same-document access under sandbox:** yes. `w.document.body` is reachable; opener and child share one OS process (pid equal).
- **CSP is inherited** by the `about:blank` child (inline script blocked there).
- **Keyboard:** React `onKeyDown` in the main tree fires for keys typed in the child (2 of 2).
- **Stylesheets:** a cloned `<link>` with the absolute URL works; so does a `CSSStyleSheet` built in the child realm and set on `adoptedStyleSheets`. `<style>` text and `<style>.sheet.insertRule` are blocked by `style-src 'self'`. `@layer` order holds in the child (computed colour `rgb(0,0,255)` from the last-ranked layer; run on `link` and `adopted`).
- **`window.open` without a gesture:** allowed in Electron here (direct call, timer, timer 2 s after a gesture, all created a window and called the handler). The CMD-011 browser gesture constraint did not apply on macOS. Not verified elsewhere.
- **CSP side effect, not child-specific:** react-aria `usePress` injects a `<style>` (touch-action) into each document; `style-src 'self'` blocks it ("Applying inline style violates ..."). Needs a CSP nonce; not tested.
- **Close with overlay open:** with a `pagehide` listener that unmounts the portal: no errors, main window clean. Without it: 165 `ResizeObserver loop completed with undelivered notifications` console errors and the opener `<body>` stays `aria-hidden="true"` after the child closes.

## Overlay matrix (real input events via `sendInputEvent`)

| mode | popover | menu | dialog | context menu | tooltip |
|---|---|---|---|---|---|
| control (no provider) | all FAIL: overlay renders in the main document | same | same | same | not opened |
| provider only | pass except focus back, hide-outside | same | same | same | FAIL (no hover open) |
| provider + 3 workarounds | all PASS | all PASS | all PASS | all PASS | PASS only with `placement="bottom"` |

Columns checked per cell: in child doc, positioned, focus in, Escape closes, focus back, outside click closes, outside hidden in child only. Full table: `out/table.md`.

## Defects with provider only (source lines in react-aria 3.53.1 `dist/private/`)

1. **Wrong document hidden:** `overlays/ariaHideOutside.mjs:33` defaults `root` to the opener's `document.body`. Child content stays exposed; the main `<body>` gets `aria-hidden`. Fix used: guard component calling `ariaHideOutside([el], {root: child body})` plus a `MutationObserver` that reverts the main body. Hack; relies on internals.
2. **Focus not returned:** `focus/FocusScope.mjs:442` captures the opener's active element at render, so focus goes to the child `<body>`. Fix used: remember the trigger and refocus on unmount.
3. **Interaction modality not tracked in the child:** tooltip hover opens only if modality is `pointer` (`tooltip/useTooltipTrigger.mjs:62`). Fix used: `addWindowFocusTracking(child.body)` from `react-aria/private/interactions/useFocusVisible` (private, unsupported).
4. **Positioning uses opener globals** (`overlays/calculatePosition.mjs:52-54,296`; `useOverlayPosition.mjs:31,92,216`): a `top` placement got `bottom:454px` (opener viewport height), so the tooltip sat at y=10 instead of above its trigger. No fix found; workaround is to avoid `top` and flipped placements. Child resize repositioning not tested.

## Affects specs

- CMD-009 and CMP-009 hold (no baseline change, one React tree) but only with the workarounds above. The Risks row "`UNSAFE_PortalProvider` is an escape hatch" is confirmed. The PortalProvider docs page does not mention child windows (fetched 2026-11-11).
- CMD-011: the gesture constraint is not observed in Electron on macOS.
- Decision for the human: accept private-API use or carry a `pnpm patch`, or file upstream (related: adobe/react-spectrum PR #7687, issue #9259; not confirmed to cover this case).

## Sources

- https://react-aria.adobe.com/PortalProvider (fetched 2026-11-11)
- react-aria 3.53.1 source in `node_modules` (paths above)
- Electron 45.3.0 behaviour measured locally; no Electron docs consulted for the gesture result
- https://github.com/adobe/react-spectrum/issues/9259, https://github.com/adobe/react-spectrum/pull/7687 (search result titles only)
