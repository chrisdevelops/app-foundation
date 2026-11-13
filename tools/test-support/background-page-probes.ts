// Test-only helper for #46 (TST-018; ADR 0013 rule 1 and amendment 1; spike #43):
// checks that a page in a background-mode window still works for tests (on
// macOS the window is never shown; on Linux and Windows it is shown without
// focus). Each probe is a page expression (a string, so it runs through raw
// CDP `Runtime.evaluate` and Playwright `page.evaluate` alike, and needs no
// DOM types):
// - paint: requestAnimationFrame callbacks per second (a hidden window that
//   stopped painting gives 0), with diagnostics in the result (visibility
//   state, timer lateness, page age) and a diagnostics-only follow-up watch
//   for a failed count; the threshold and the verdict do not depend on them;
// - screenshot: a full-window overlay of a known colour, then the centre pixel
//   of `Page.captureScreenshot` must be that colour (a blank or stale image fails);
// - key input: an input the probe creates and focuses; the caller sends keys
//   through CDP and reads the value back;
// - focus: `document.hasFocus()` read without CDP focus emulation is false in
//   a window that never took OS focus.
// Every CDP call a probe makes has its own time limit
// (`backgroundProbeStepTimeoutMs`, `withBackgroundProbeTimeout`): PR #47 CI
// showed `Page.captureScreenshot` can stay unanswered forever, and a probe must
// then fail at once with the step it waited for, not at the test timeout.
// Also a small PNG decoder (8-bit RGB or RGBA, not interlaced: what Chromium's
// `Page.captureScreenshot` writes), so the gate reads pixels without a dependency.
import { inflateSync } from 'node:zlib';

/** Time limit of one CDP call in a background probe (a screenshot of a painted page answers in well under 1 s). */
export const backgroundProbeStepTimeoutMs = 20_000;

/**
 * Resolves or rejects as `step` does, or rejects after `timeoutMs` with an error that names `label`
 * ("<label> got no answer in <n> ms"), so a CDP call that never answers fails fast.
 */
export async function withBackgroundProbeTimeout<T>(
  label: string,
  step: Promise<T>,
  timeoutMs: number = backgroundProbeStepTimeoutMs,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} got no answer in ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([step, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long the focus probe watches the page (spike #43: a shown window takes focus within 1.5 s). */
export const focusProbeWatchMs = 1_500;

/**
 * Watches the page for `focusProbeWatchMs`: reads `document.hasFocus()` every 100 ms and counts `focus`
 * events on the window. Resolves with `{ focusedSamples, samples, focusEvents }`. Read it without CDP
 * focus emulation (Playwright's `connectOverCDP` turns emulation on, which makes `hasFocus()` true).
 */
export const watchDocumentFocusExpression = `new Promise((resolve) => {
  let samples = 0;
  let focusedSamples = 0;
  let focusEvents = 0;
  const onFocus = () => { focusEvents += 1; };
  window.addEventListener('focus', onFocus);
  const sample = () => { samples += 1; if (document.hasFocus()) focusedSamples += 1; };
  sample();
  const timer = setInterval(sample, 100);
  setTimeout(() => {
    clearInterval(timer);
    sample();
    window.removeEventListener('focus', onFocus);
    resolve({ focusedSamples, samples, focusEvents });
  }, ${focusProbeWatchMs});
})`;

/** What `watchDocumentFocusExpression` resolves with. */
export interface DocumentFocusWatch {
  readonly focusedSamples: number;
  readonly samples: number;
  readonly focusEvents: number;
}

/** Problems with a focus watch of a background-mode page; empty when the page never had focus. */
export function listDocumentFocusProblems(watch: DocumentFocusWatch | null | undefined): string[] {
  if (!watch || !(watch.samples > 0)) return [`the focus probe returned no samples (${JSON.stringify(watch)})`];
  const problems: string[] = [];
  if (watch.focusedSamples > 0) {
    problems.push(
      `document.hasFocus() was true in ${watch.focusedSamples} of ${watch.samples} samples over ${focusProbeWatchMs} ms: the window has OS focus`,
    );
  }
  if (watch.focusEvents > 0) problems.push(`the window received ${watch.focusEvents} focus events`);
  return problems;
}

/** Colour of the overlay the screenshot probe paints: magenta, so each channel is either full or empty. */
export const screenshotProbeColour = { red: 255, green: 0, blue: 255 } as const;
/**
 * A full channel must read at least this much and an empty one at most 255 minus this: macOS screenshots
 * carry the display colour profile, which moves channel values (a mid-range colour moved by 37 in a trial run).
 */
export const screenshotProbeChannelThreshold = 180;
/** Fewest animation frames per second that count as painting (spike #43 measured 60 in background mode). */
export const minimumAnimationFramesPerSecond = 10;
/** Text the key-input probe types. */
export const keyProbeText = 'tst018';
/** Accessible name of the input the key-input probe creates. */
export const keyProbeInputName = 'Background mode key probe';

// Page state the paint probes read with every result, so a failure tells a page
// that Chromium treats as hidden or occluded (`visibilityState` "hidden",
// `visibilitychange` events) apart from a renderer that stalled (the 1 s timer
// itself fired late) and from a page that was just (re)loaded (`pageAgeMs`,
// `navigationType`). PR #47 CI: the dev window on Ubuntu painted 0 frames in 2 of 5 runs.
const pageStateFields = `
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    pageAgeMs: Math.round(performance.now()),
    navigationType: (performance.getEntriesByType('navigation')[0] || {}).type || null,
    href: location.href,
    innerSize: innerWidth + ' x ' + innerHeight,
    outerSize: outerWidth + ' x ' + outerHeight,
    screenPosition: screenX + ', ' + screenY,`;

/** Page state read at one moment of a paint probe (see `pageStateFields`). */
export interface PaintProbePageState {
  readonly visibilityState: string;
  readonly hidden: boolean;
  readonly hasFocus: boolean;
  /** `performance.now()`: time since the page's navigation started. */
  readonly pageAgeMs: number;
  /** "navigate", "reload", "back_forward" or null. */
  readonly navigationType: string | null;
  readonly href: string;
  readonly innerSize: string;
  readonly outerSize: string;
  readonly screenPosition: string;
}

/**
 * Counts animation frames for one second (a timer ends the count, so a page that never paints gives 0)
 * and resolves with a `PaintProbeResult`: the count, how late the 1 s timer fired, when the first frame
 * came, every `visibilitychange` during the count, and the page state at the start and at the end.
 */
export const paintProbeExpression = `new Promise((resolve) => {
  const readState = () => ({${pageStateFields}
  });
  const start = performance.now();
  const atStart = readState();
  const visibilityChanges = [];
  const onVisibility = () => { visibilityChanges.push(Math.round(performance.now() - start) + ' ms: ' + document.visibilityState); };
  document.addEventListener('visibilitychange', onVisibility);
  let frames = 0;
  let firstFrameAfterMs = null;
  const tick = () => {
    if (frames === 0) firstFrameAfterMs = Math.round(performance.now() - start);
    frames += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    resolve({
      frames,
      timerElapsedMs: Math.round(performance.now() - start),
      firstFrameAfterMs,
      visibilityChanges,
      atStart,
      atEnd: readState(),
    });
  }, 1000);
})`;

/** What `paintProbeExpression` resolves with. */
export interface PaintProbeResult {
  /** Animation frames in the one-second count. */
  readonly frames: number;
  /** When the 1 s timer that ends the count fired; far above 1000 means the renderer main thread stalled. */
  readonly timerElapsedMs: number;
  /** When the first animation frame came after the count started; null when none came. */
  readonly firstFrameAfterMs: number | null;
  /** Each `visibilitychange` during the count: "<ms after start> ms: <visibilityState>". */
  readonly visibilityChanges: readonly string[];
  readonly atStart: PaintProbePageState;
  readonly atEnd: PaintProbePageState;
}

/** One line with every diagnostic field of a paint probe result. */
export function describePaintProbeResult(result: PaintProbeResult | null | undefined): string {
  if (!result || typeof result !== 'object') return `paint probe returned ${JSON.stringify(result)}`;
  return `paint probe: frames ${result.frames}, 1 s timer fired after ${result.timerElapsedMs} ms, first frame after ${
    result.firstFrameAfterMs === null ? 'none' : `${result.firstFrameAfterMs} ms`
  }, visibilitychange events ${JSON.stringify(result.visibilityChanges)}; at start ${JSON.stringify(
    result.atStart,
  )}; at end ${JSON.stringify(result.atEnd)}`;
}

/**
 * Problems with a paint probe result; empty when the page painted at least `minimumAnimationFramesPerSecond`
 * frames in the second. The problem names every diagnostic field (`describePaintProbeResult`).
 */
export function listPaintProbeProblems(result: PaintProbeResult | null | undefined): string[] {
  const frames = result && typeof result === 'object' ? result.frames : undefined;
  if (typeof frames === 'number' && frames >= minimumAnimationFramesPerSecond) return [];
  return [
    `the page painted ${String(frames)} animation frames in one second (at least ${minimumAnimationFramesPerSecond} expected); ${describePaintProbeResult(result)}`,
  ];
}

/** How long `watchPaintAfterStallExpression` waits for animation frames after a failed paint probe. */
export const paintStallWatchMs = 5_000;

/**
 * Diagnostics only, after a paint probe failed (it never changes the verdict): watches the page for
 * `paintStallWatchMs` and resolves with `PaintStallWatch`, so the failure tells a short stall (frames
 * come back) from a page that stopped painting (no frame in the whole watch).
 */
export const watchPaintAfterStallExpression = `new Promise((resolve) => {
  const start = performance.now();
  const visibilityChanges = [];
  const onVisibility = () => { visibilityChanges.push(Math.round(performance.now() - start) + ' ms: ' + document.visibilityState); };
  document.addEventListener('visibilitychange', onVisibility);
  let frames = 0;
  let firstFrameAfterMs = null;
  const tick = () => {
    if (frames === 0) firstFrameAfterMs = Math.round(performance.now() - start);
    frames += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    resolve({
      watchMs: Math.round(performance.now() - start),
      frames,
      firstFrameAfterMs,
      visibilityChanges,
      visibilityState: document.visibilityState,
      hidden: document.hidden,
    });
  }, ${paintStallWatchMs});
})`;

/** What `watchPaintAfterStallExpression` resolves with. */
export interface PaintStallWatch {
  readonly watchMs: number;
  readonly frames: number;
  readonly firstFrameAfterMs: number | null;
  readonly visibilityChanges: readonly string[];
  readonly visibilityState: string;
  readonly hidden: boolean;
}

/**
 * Adds a fixed full-window overlay in the probe colour and resolves after two animation frames, or after
 * 2 s when no frames come, with a `ScreenshotOverlayResult` that says which of the two ended the wait.
 */
export const paintScreenshotOverlayExpression = `new Promise((resolve) => {
  const start = performance.now();
  const overlay = document.createElement('div');
  overlay.id = 'tst018-screenshot-probe';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.zIndex = '2147483647';
  overlay.style.background = 'rgb(${screenshotProbeColour.red}, ${screenshotProbeColour.green}, ${screenshotProbeColour.blue})';
  document.documentElement.appendChild(overlay);
  let settled = false;
  const done = (settledBy) => {
    if (settled) return;
    settled = true;
    resolve({
      settledBy,
      elapsedMs: Math.round(performance.now() - start),
      visibilityState: document.visibilityState,
      hidden: document.hidden,
    });
  };
  requestAnimationFrame(() => requestAnimationFrame(() => done('animation-frame')));
  setTimeout(() => done('timer'), 2000);
})`;

/** What `paintScreenshotOverlayExpression` resolves with. */
export interface ScreenshotOverlayResult {
  /** "animation-frame": two frames came; "timer": no two frames in 2 s, the fallback timer ended the wait. */
  readonly settledBy: 'animation-frame' | 'timer';
  readonly elapsedMs: number;
  readonly visibilityState: string;
  readonly hidden: boolean;
}

/** Removes the screenshot overlay. */
export const removeScreenshotOverlayExpression = `(() => { document.getElementById('tst018-screenshot-probe')?.remove(); return true; })()`;

/** Adds an input named `keyProbeInputName`, focuses it and returns whether it is the active element. */
export const focusKeyProbeInputExpression = `(() => {
  const input = document.createElement('input');
  input.setAttribute('aria-label', ${JSON.stringify(keyProbeInputName)});
  document.body.appendChild(input);
  input.focus();
  globalThis.__tst018KeyProbe = input;
  return document.activeElement === input;
})()`;

/** The value of the key-input probe. */
export const readKeyProbeValueExpression = `(globalThis.__tst018KeyProbe ? globalThis.__tst018KeyProbe.value : null)`;

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row by row. */
  readonly rgba: Uint8Array;
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** True when `data` starts with the PNG signature. */
export function isPng(data: Uint8Array): boolean {
  return Buffer.from(data.subarray(0, 8)).equals(pngSignature);
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** Decodes an 8-bit RGB or RGBA PNG without interlacing; throws for anything else. */
export function decodePng(data: Uint8Array): DecodedPng {
  const buffer = Buffer.from(data);
  if (!isPng(buffer)) throw new Error('not a PNG: the signature is missing');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  const compressed: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body.readUInt8(8);
      colourType = body.readUInt8(9);
      const interlace = body.readUInt8(12);
      if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6) || interlace !== 0) {
        throw new Error(`unsupported PNG: bit depth ${bitDepth}, colour type ${colourType}, interlace ${interlace}`);
      }
    } else if (type === 'IDAT') {
      compressed.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error('PNG without IHDR or with an empty size');
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(compressed));
  const pixels = new Uint8Array(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] ?? 0;
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    for (let index = 0; index < stride; index += 1) {
      const value = raw[source + index] ?? 0;
      const left = index >= channels ? (pixels[target + index - channels] ?? 0) : 0;
      const up = row > 0 ? (pixels[target - stride + index] ?? 0) : 0;
      const upLeft = row > 0 && index >= channels ? (pixels[target - stride + index - channels] ?? 0) : 0;
      let decoded: number;
      if (filter === 0) decoded = value;
      else if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + Math.floor((left + up) / 2);
      else if (filter === 4) decoded = value + paeth(left, up, upLeft);
      else throw new Error(`unsupported PNG row filter ${filter}`);
      pixels[target + index] = decoded & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = pixels[pixel * channels] ?? 0;
    rgba[pixel * 4 + 1] = pixels[pixel * channels + 1] ?? 0;
    rgba[pixel * 4 + 2] = pixels[pixel * channels + 2] ?? 0;
    rgba[pixel * 4 + 3] = channels === 4 ? (pixels[pixel * channels + 3] ?? 0) : 255;
  }
  return { width, height, rgba };
}

/** The colour of the centre pixel. */
export function readCentrePixel(image: DecodedPng): { red: number; green: number; blue: number; alpha: number } {
  const x = Math.floor(image.width / 2);
  const y = Math.floor(image.height / 2);
  const index = (y * image.width + x) * 4;
  return {
    red: image.rgba[index] ?? 0,
    green: image.rgba[index + 1] ?? 0,
    blue: image.rgba[index + 2] ?? 0,
    alpha: image.rgba[index + 3] ?? 0,
  };
}

/** Problems with a screenshot taken over the probe overlay; empty when it shows the probe colour. */
export function listScreenshotProbeProblems(data: Uint8Array): string[] {
  if (!isPng(data)) return [`the screenshot is not a PNG (${data.length} bytes)`];
  let image: DecodedPng;
  try {
    image = decodePng(data);
  } catch (error) {
    return [`the screenshot PNG cannot be decoded: ${error instanceof Error ? error.message : String(error)}`];
  }
  const centre = readCentrePixel(image);
  const off = (['red', 'green', 'blue'] as const).filter((channel) =>
    screenshotProbeColour[channel] === 255
      ? centre[channel] < screenshotProbeChannelThreshold
      : centre[channel] > 255 - screenshotProbeChannelThreshold,
  );
  if (off.length === 0 && centre.alpha === 255) return [];
  return [
    `the screenshot (${image.width} x ${image.height}) shows rgba(${centre.red}, ${centre.green}, ${centre.blue}, ${centre.alpha}) at its centre, not the painted probe colour rgb(${screenshotProbeColour.red}, ${screenshotProbeColour.green}, ${screenshotProbeColour.blue})`,
  ];
}
