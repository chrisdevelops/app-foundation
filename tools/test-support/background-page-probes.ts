// Test-only helper for #46 (TST-018; ADR 0013; spike #43): checks that a page
// in a window that is never shown still works for tests. Each probe is a page
// expression (a string, so it runs through raw CDP `Runtime.evaluate` and
// Playwright `page.evaluate` alike, and needs no DOM types):
// - paint: requestAnimationFrame callbacks per second (a hidden window that
//   stopped painting gives 0);
// - screenshot: a full-window overlay of a known colour, then the centre pixel
//   of `Page.captureScreenshot` must be that colour (a blank or stale image fails);
// - key input: an input the probe creates and focuses; the caller sends keys
//   through CDP and reads the value back.
// Also a small PNG decoder (8-bit RGB or RGBA, not interlaced: what Chromium's
// `Page.captureScreenshot` writes), so the gate reads pixels without a dependency.
import { inflateSync } from 'node:zlib';

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

/** Resolves with the number of animation frames in one second (a timer ends the count, so a page that never paints gives 0). */
export const animationFramesPerSecondExpression = `new Promise((resolve) => {
  let frames = 0;
  const tick = () => { frames += 1; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setTimeout(() => resolve(frames), 1000);
})`;

/** Adds a fixed full-window overlay in the probe colour and resolves after two animation frames (or 2 s). */
export const paintScreenshotOverlayExpression = `new Promise((resolve) => {
  const overlay = document.createElement('div');
  overlay.id = 'tst018-screenshot-probe';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.zIndex = '2147483647';
  overlay.style.background = 'rgb(${screenshotProbeColour.red}, ${screenshotProbeColour.green}, ${screenshotProbeColour.blue})';
  document.documentElement.appendChild(overlay);
  const done = () => resolve(true);
  requestAnimationFrame(() => requestAnimationFrame(done));
  setTimeout(done, 2000);
})`;

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
