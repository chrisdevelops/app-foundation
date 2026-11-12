# Upstream report draft: React Aria overlays in a second window

> **Status:** draft for the human to review and post. Nothing here has been posted.
> **Source:** spike #8, branch `spike/8-child-window-overlays`, `docs/spikes/8-child-window-overlays.md`.

## Where to report

Repository: [adobe/react-spectrum](https://github.com/adobe/react-spectrum). Checked on 2026-11-11.

| Fault | Existing issue | Action |
| --- | --- | --- |
| 1. `ariaHideOutside` hides the opener's `<body>` | [#10581](https://github.com/adobe/react-spectrum/issues/10581) (open, 2 comments) | Optional: add comment A below |
| 2. Focus is not returned to the trigger | None found | Post the new issue below |
| 3. Tooltip hover never opens (modality not tracked in the child) | None found | Same new issue |
| 4. Positioning uses the opener's viewport | [#10951](https://github.com/adobe/react-spectrum/issues/10951) (open, 0 comments) | Optional: add comment B below |

Umbrella issue: [#4634](https://github.com/adobe/react-spectrum/issues/4634) "Use the correct ownerDocument". [#3350](https://github.com/adobe/react-spectrum/issues/3350) (closed) is about `FocusScope contain` in iframes and is a different fault.

Steps to post the new issue:

1. Open <https://github.com/adobe/react-spectrum/issues/new/choose>.
2. Select the bug report template.
3. Copy the title and the body from "New issue" below.
4. Before you submit, search again for "restore focus second window" and "useFocusVisible window.open", because issues may have been filed since 2026-11-11.

Our reproduction runs in Electron only. The code paths are not Electron-specific, but we did not test in a browser. The text below says this.

---

## New issue

**Title:** Focus is not restored and tooltip hover never opens when overlays render in a second window

**Body:**

### 🐛 Bug Report

When a React tree is portaled into a second window's document (`window.open()`, same origin) and overlays use `UNSAFE_PortalProvider` with a container in that document, two behaviours break:

1. **Focus is not restored to the trigger** when a Popover, Menu, Dialog or context menu closes. Focus lands on the second window's `<body>`.
2. **Tooltip hover never opens** in the second window. Focus-visible and interaction-modality tracking listen only on the opener window, so the modality is never `pointer` for events in the second window.

This is related to #4634. Positioning (#10951) and `ariaHideOutside` (#10581) in a second window are reported separately.

### 🤔 Expected Behavior

1. On close, focus returns to the element that had focus in the overlay's own document, normally the trigger.
2. Hovering a `TooltipTrigger` in the second window opens the tooltip, as in the main window.

### 😯 Current Behavior

1. `FocusScope` with `restoreFocus` captures the element to restore from the opener's `document.activeElement` (`focus/FocusScope` in `react-aria` 3.53.1, `dist/private/focus/FocusScope.mjs:442`). In the second window this is not the trigger, so focus falls to the second window's `<body>`.
2. `useTooltipTrigger` opens on hover only when the interaction modality is `pointer` (`dist/private/tooltip/useTooltipTrigger.mjs:62`). The modality listeners are installed on the opener window only, so pointer events in the second window do not update it.

### 💁 Possible Solution

1. Read the active element from the owner document of the scope's nodes, for example `getOwnerDocument(node).activeElement`.
2. Install modality tracking for each window that hosts a portal container. Calling `addWindowFocusTracking(secondWindow.document.body)` from `react-aria/private/interactions/useFocusVisible` makes hover tooltips work in our test, but this is a private path. A public API, or automatic tracking from `PortalProvider`, would remove the need for it.

### 🔦 Context

We build desktop apps where a user can tear a tab off into its own window. The torn-off window is rendered from the main React tree with `createPortal`, so state and theme stay shared. Workarounds today: remember the trigger and refocus it on unmount, and call the private `addWindowFocusTracking`.

### 💻 Code Sample

```tsx
import { createPortal } from 'react-dom';
import { UNSAFE_PortalProvider } from '@react-aria/overlays';
import { Button, Dialog, DialogTrigger, Popover, Tooltip, TooltipTrigger } from 'react-aria-components';

const child = window.open('about:blank', '', 'width=600,height=400')!;
const container = child.document.createElement('div');
child.document.body.append(container);

function ChildWindow() {
  return createPortal(
    <UNSAFE_PortalProvider getContainer={() => container}>
      <DialogTrigger>
        <Button>Open popover</Button>
        <Popover><Dialog>Content</Dialog></Popover>
      </DialogTrigger>
      <TooltipTrigger>
        <Button>Hover me</Button>
        <Tooltip>Tip</Tooltip>
      </TooltipTrigger>
    </UNSAFE_PortalProvider>,
    container,
  );
}
```

Steps:

1. Click "Open popover" in the second window, then press Escape. Focus is on `<body>`, not on the button.
2. Move the mouse over "Hover me" in the second window. The tooltip does not open.

### 🌍 Your Environment

| Software | Version |
| --- | --- |
| react-aria-components | 1.22.1 |
| react-aria | 3.53.1 |
| @react-aria/overlays | 3.32.1 |
| React | 19.3.1 |
| Electron | 45.3.0 (Chromium 156.0.8078.96) |
| OS | macOS 26.6.2 arm64 |

Tested in Electron with real input events. Not tested in a browser; the code paths above are not Electron-specific.

---

## Comment A, optional, on #10581

> Confirming with react-aria 3.53.1 / react-aria-components 1.22.1 (React 19.3.1, Electron 45.3.0): with `UNSAFE_PortalProvider` pointing at a `window.open()` child document, Popover, Menu, Dialog and context menu all set `aria-hidden` on the opener's `<body>` and leave the child's content exposed (`dist/private/overlays/ariaHideOutside.mjs:33`). If the child window closes while an overlay is open, the opener's `<body>` stays `aria-hidden="true"` unless the portal is unmounted on `pagehide`. Our workaround calls `ariaHideOutside([el], { root: childDocument.body })` and reverts the opener body with a `MutationObserver`, which depends on internals.

## Comment B, optional, on #10951

> Confirming with react-aria 3.53.1 (React 19.3.1, Electron 45.3.0, macOS): a Tooltip with `placement="top"` in a `window.open()` child got `bottom: 454px`, which is the opener's viewport height, so it rendered at y=10 instead of above its trigger (`dist/private/overlays/calculatePosition.mjs:52-54,296`; `useOverlayPosition.mjs:31,92,216`). `bottom`, `right` and centred placements were correct in our test. We avoid `top` and flipped placements in child windows until this is fixed.
