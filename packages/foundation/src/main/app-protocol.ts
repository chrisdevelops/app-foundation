// The foundation's `app://` protocol handler (#15; PLT-008; ADR 0004 decision 1 A).
// Packaged apps load their renderers through `app://<host>/...` instead of
// `file://`, so the GrantFileProtocolExtraPrivileges fuse can stay off.
//
// Input: `{ host, rendererDir }`. Output: a handler of the shape
// `protocol.handle` takes, `(request: Request) => Promise<Response>`.
// - `app://<host>/<path>` answers 200 with the bytes of `<rendererDir>/<path>`
//   and a Content-Type for its extension.
// - Everything else answers a 4xx with an empty body: another scheme or host
//   (403), a malformed or unsafe path (400), a missing file or a folder (404).
//   An unsafe path is any segment that is empty, `.` or `..` (also when
//   percent-encoded), or that holds `/`, `\`, `:`, `%` or a control character
//   after decoding. So no traversal, absolute path, drive letter, double
//   encoding or NUL byte reaches the file system.
// - A file whose real path (links and junctions resolved) is outside the real
//   path of `rendererDir` answers 404; links that stay inside are served.
//   `fs.promises.realpath` works inside app.asar (Electron's asar fs support).
// - Every Response, served or refused, carries the Content-Security-Policy
//   header `appProtocolContentSecurityPolicy` (#18; PLT-008, PLT-012; ADR 0004
//   decision 9 B): `script-src 'self'` with no inline scripts and no eval;
//   `style-src` allows `'unsafe-inline'` (react-aria injects inline styles).
//   `about:blank` child windows inherit it from their opener.
//
// This module has no runtime import of `electron`, so it runs in plain Node
// (the gate test runs it on every OS). The Electron side is in
// `app-protocol-registration.ts`.
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

/** The URL scheme the foundation registers for packaged renderers. */
export const appProtocolScheme = 'app';

export interface AppProtocolHandlerOptions {
  /** The one host the handler serves, for example `rf`. Any other host is refused. */
  readonly host: string;
  /** Absolute path of the folder that holds the built renderer output. */
  readonly rendererDir: string;
}

export type AppProtocolHandler = (request: Request) => Promise<Response>;

const appProtocolContentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

const appProtocolFallbackContentType = 'application/octet-stream';

/**
 * The Content-Security-Policy on every `app://` response (ADR 0004 decision 9 B).
 * Scripts only from the app's own origin; inline styles allowed, with no nonce or
 * hash in `style-src` (either would make browsers ignore `'unsafe-inline'`).
 */
export const appProtocolContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// After decoding, a segment must not hold a separator, a drive or stream
// colon, a percent sign (double encoding) or a control character.
// eslint-disable-next-line no-control-regex
const unsafeDecodedSegment = /[/\\:%\u0000-\u001f\u007f]/;

function refuse(status: 400 | 403 | 404): Response {
  return new Response(null, { status, headers: { 'content-security-policy': appProtocolContentSecurityPolicy } });
}

/** The decoded path segments of `pathname`, or undefined when any segment is unsafe. */
function readSafePathSegments(pathname: string): string[] | undefined {
  if (!pathname.startsWith('/')) return undefined;
  const segments: string[] = [];
  for (const raw of pathname.slice(1).split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (decoded === '' || decoded === '.' || decoded === '..') return undefined;
    if (unsafeDecodedSegment.test(decoded)) return undefined;
    segments.push(decoded);
  }
  return segments;
}

/** True when `path` is `dir` itself or a path inside it. */
function isInsideDir(dir: string, path: string): boolean {
  const fromDir = relative(dir, path);
  return fromDir !== '' && !fromDir.startsWith('..') && !isAbsolute(fromDir);
}

/**
 * Creates the `app://` handler for one host and one renderer output folder.
 * Throws when `host` is empty or `rendererDir` is not absolute.
 */
export function createAppProtocolHandler(options: AppProtocolHandlerOptions): AppProtocolHandler {
  const { host } = options;
  if (!/^[a-z0-9-]+$/.test(host)) {
    throw new Error(
      `createAppProtocolHandler: host must be lower-case letters, digits and "-", got ${JSON.stringify(host)}`,
    );
  }
  if (!isAbsolute(options.rendererDir)) {
    throw new Error(
      `createAppProtocolHandler: rendererDir must be an absolute path, got ${JSON.stringify(options.rendererDir)}`,
    );
  }
  const rendererDir = resolve(options.rendererDir);

  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return refuse(400);
    }
    if (url.protocol !== `${appProtocolScheme}:` || url.host !== host) return refuse(403);
    const segments = readSafePathSegments(url.pathname);
    if (!segments) return refuse(400);
    const filePath = join(rendererDir, ...segments);
    if (!isInsideDir(rendererDir, filePath)) return refuse(400);
    try {
      // Links (symbolic links, junctions) may point anywhere: compare real
      // paths, and read the real path so a link cannot change in between.
      const realRendererDir = await realpath(rendererDir);
      const realFilePath = await realpath(filePath);
      if (!isInsideDir(realRendererDir, realFilePath)) return refuse(404);
      if (!(await stat(realFilePath)).isFile()) return refuse(404);
      const body = await readFile(realFilePath);
      const contentType = appProtocolContentTypes[extname(filePath).toLowerCase()] ?? appProtocolFallbackContentType;
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'content-type': contentType, 'content-security-policy': appProtocolContentSecurityPolicy },
      });
    } catch {
      return refuse(404);
    }
  };
}
