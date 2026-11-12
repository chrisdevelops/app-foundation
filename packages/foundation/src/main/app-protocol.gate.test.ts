// Gate tests for #15: the foundation's `app://` protocol handler (PLT-008;
// ADR 0004 decision 1 A). Apps call it from the main process, not from their
// own code:
//
//   protocol.handle('app', createAppProtocolHandler({ host, rendererDir }))
//
// Contract (input and output):
// - Module `packages/foundation/src/main/app-protocol.ts` exports
//   `createAppProtocolHandler(options: { host: string; rendererDir: string })`.
//   It returns `(request: Request) => Promise<Response>`, the handler shape
//   `protocol.handle` takes. The module loads in plain Node (no runtime import
//   of `electron`), so this gate runs it on Windows, macOS and Linux.
// - `app://<host>/<path>` answers 200 with the bytes of `<rendererDir>/<path>`
//   and a Content-Type the renderer accepts (module scripts need a JavaScript
//   type).
// - Everything else is refused: a missing file or a folder, `..` segments,
//   encoded traversal (`%2e%2e`, `%2f`, `%5c`, double encoding), raw
//   backslashes, absolute paths, NUL bytes and any host other than `<host>`.
//   Refused means the promise rejects, or the response is an error response
//   (status 0) or a 4xx; never a 2xx or 3xx, and never a byte of a file outside
//   `rendererDir`.
// The packaged-app gate (tools/reference-app) runs the same refusals through
// Chromium in the packaged reference app.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface AppProtocolHandlerOptions {
  readonly host: string;
  readonly rendererDir: string;
}

type AppProtocolHandler = (request: Request) => Promise<Response>;

interface AppProtocolModule {
  readonly createAppProtocolHandler: (options: AppProtocolHandlerOptions) => AppProtocolHandler;
}

const appProtocolModuleUrl = new URL('./app-protocol.ts', import.meta.url).href;

/** Loads the system under test; a missing module or export fails each test with the contract text. */
async function loadAppProtocolModule(): Promise<AppProtocolModule> {
  let loaded: Partial<AppProtocolModule>;
  try {
    loaded = (await import(/* @vite-ignore */ appProtocolModuleUrl)) as Partial<AppProtocolModule>;
  } catch (error) {
    throw new Error(
      `packages/foundation/src/main/app-protocol.ts must exist and load in plain Node: ${(error as Error).message}`,
      { cause: error },
    );
  }
  if (typeof loaded.createAppProtocolHandler !== 'function') {
    throw new Error('packages/foundation/src/main/app-protocol.ts must export a createAppProtocolHandler function');
  }
  return loaded as AppProtocolModule;
}

const host = 'rf-gate';
const indexHtml = '<!doctype html><title>gate</title><p>INDEX-MARKER-6f1c</p>';
const scriptText = 'export const marker = "SCRIPT-MARKER-91ab";\n';
const styleText = '.marker { color: red; } /* STYLE-MARKER-2d4e */\n';
const outsideSecret = 'OUTSIDE-SECRET-5b7e';
const siblingSecret = 'SIBLING-SECRET-0c3a';

let baseDir = '';
let rendererDir = '';
let outsideSecretPath = '';
let handler: AppProtocolHandler | undefined;

function writeFixtureFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(() => {
  // Real path, so absolute-path cases use the spelling the handler would see
  // (macOS /var -> /private/var; Windows 8.3 short names expanded).
  baseDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'app-protocol-gate-')));
  rendererDir = join(baseDir, 'renderer');
  writeFixtureFile(join(rendererDir, 'index.html'), indexHtml);
  writeFixtureFile(join(rendererDir, 'assets', 'index-abc123.js'), scriptText);
  writeFixtureFile(join(rendererDir, 'assets', 'index-abc123.css'), styleText);
  // Outside rendererDir: a file in the parent folder, and one in a sibling
  // folder whose name starts with the renderer folder's name.
  outsideSecretPath = join(baseDir, 'secret.txt');
  writeFixtureFile(outsideSecretPath, outsideSecret);
  writeFixtureFile(join(baseDir, 'renderer-sibling', 'secret.txt'), siblingSecret);
});

afterAll(() => {
  if (baseDir) rmSync(baseDir, { recursive: true, force: true });
});

async function handlerUnderTest(): Promise<AppProtocolHandler> {
  if (!handler) {
    const { createAppProtocolHandler } = await loadAppProtocolModule();
    handler = createAppProtocolHandler({ host, rendererDir });
    expect(typeof handler, 'createAppProtocolHandler must return the handler function').toBe('function');
  }
  return handler;
}

interface HandlerOutcome {
  readonly url: string;
  readonly rejected: boolean;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly rejection: string;
}

async function requestApp(url: string): Promise<HandlerOutcome> {
  const handle = await handlerUnderTest();
  try {
    const response = await handle(new Request(url));
    const body = response.type === 'error' ? '' : await response.text();
    return {
      url,
      rejected: false,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      body,
      rejection: '',
    };
  } catch (error) {
    return { url, rejected: true, status: 0, contentType: '', body: '', rejection: String(error) };
  }
}

function describeOutcome(outcome: HandlerOutcome): string {
  return outcome.rejected
    ? `${outcome.url} -> rejected: ${outcome.rejection}`
    : `${outcome.url} -> ${outcome.status} ${outcome.contentType} ${JSON.stringify(outcome.body.slice(0, 200))}`;
}

const allMarkers = [outsideSecret, siblingSecret, 'INDEX-MARKER-6f1c', 'SCRIPT-MARKER-91ab', 'STYLE-MARKER-2d4e'];

/** Refused: rejected, an error response or a 4xx, and no fixture content in the body. */
function expectRefused(outcome: HandlerOutcome, forbiddenMarkers: readonly string[] = allMarkers): void {
  const refusedStatus = outcome.rejected || outcome.status === 0 || (outcome.status >= 400 && outcome.status < 500);
  expect(refusedStatus, `must be refused (reject, error response or 4xx): ${describeOutcome(outcome)}`).toBe(true);
  for (const marker of forbiddenMarkers) {
    expect(outcome.body, `the refusal must not carry file content: ${describeOutcome(outcome)}`).not.toContain(marker);
  }
}

/** Forward-slash form of an absolute path (`/tmp/x` or `C:/Users/x`). */
function toForwardSlashes(path: string): string {
  return path.split('\\').join('/');
}

describe('app:// protocol handler: files inside the renderer output', () => {
  // PLT-008
  it('PLT-008: app://<host>/index.html answers 200 with the file bytes and an HTML content type', async () => {
    const outcome = await requestApp(`app://${host}/index.html`);
    expect(outcome.rejected, describeOutcome(outcome)).toBe(false);
    expect(outcome.status, describeOutcome(outcome)).toBe(200);
    expect(outcome.body).toBe(indexHtml);
    expect(outcome.contentType).toMatch(/^text\/html\b/i);
  });

  // PLT-008: module scripts load only with a JavaScript MIME type
  it('PLT-008: a script in a subfolder answers 200 with a JavaScript content type', async () => {
    const outcome = await requestApp(`app://${host}/assets/index-abc123.js`);
    expect(outcome.status, describeOutcome(outcome)).toBe(200);
    expect(outcome.body).toBe(scriptText);
    expect(outcome.contentType).toMatch(/^(text|application)\/javascript\b/i);
  });

  // PLT-008
  it('PLT-008: a stylesheet answers 200 with a CSS content type', async () => {
    const outcome = await requestApp(`app://${host}/assets/index-abc123.css`);
    expect(outcome.status, describeOutcome(outcome)).toBe(200);
    expect(outcome.body).toBe(styleText);
    expect(outcome.contentType).toMatch(/^text\/css\b/i);
  });

  // PLT-008, failure mode: a missing file
  it('PLT-008: a file that does not exist in the renderer output is refused', async () => {
    const outcome = await requestApp(`app://${host}/assets/missing.js`);
    expectRefused(outcome);
  });

  // PLT-008, failure mode: a folder is not a file
  it('PLT-008: a folder inside the renderer output is refused, with no listing', async () => {
    expectRefused(await requestApp(`app://${host}/assets`));
    expectRefused(await requestApp(`app://${host}/assets/`));
  });
});

describe('app:// protocol handler: failure modes', () => {
  // PLT-008, failure mode: `..` segments (the URL parser removes plain ones; none may escape)
  it.each([
    ['/../secret.txt'],
    ['/assets/../../secret.txt'],
    ['/../renderer-sibling/secret.txt'],
    ['/./../secret.txt'],
  ])('PLT-008: a path with .. segments (%s) is refused', async (path) => {
    expectRefused(await requestApp(`app://${host}${path}`));
  });

  // PLT-008, failure mode: encoded traversal
  it.each([
    ['%2e%2e as a segment', '/%2e%2e/secret.txt'],
    ['upper-case %2E%2E', '/%2E%2E/%2E%2E/secret.txt'],
    ['.. with an encoded slash', '/..%2fsecret.txt'],
    ['%2e%2e with an encoded slash', '/%2e%2e%2fsecret.txt'],
    ['encoded traversal from a subfolder', '/assets/..%2f..%2fsecret.txt'],
    ['encoded traversal into a sibling folder with the same name prefix', '/..%2frenderer-sibling%2fsecret.txt'],
    ['.. with an encoded backslash', '/..%5csecret.txt'],
    ['%2e%2e with an encoded backslash', '/%2e%2e%5csecret.txt'],
    ['double-encoded traversal', '/%252e%252e%252fsecret.txt'],
    ['mixed encoded and plain dots', '/.%2e%2fsecret.txt'],
  ])('PLT-008: encoded traversal (%s) is refused', async (_label, path) => {
    expectRefused(await requestApp(`app://${host}${path}`));
  });

  // PLT-008, failure mode: a raw backslash is a separator on Windows
  it('PLT-008: a path with a raw backslash traversal (..\\secret.txt) is refused', async () => {
    expectRefused(await requestApp(`app://${host}/..\\secret.txt`));
    expectRefused(await requestApp(`app://${host}/assets\\..\\..\\secret.txt`));
  });

  // PLT-008, failure mode: absolute paths
  it('PLT-008: an absolute path to a file outside the renderer output is refused, raw or encoded', async () => {
    const forward = toForwardSlashes(outsideSecretPath);
    const urls = [
      // Raw: //tmp/... on POSIX, /C:/Users/... on Windows.
      `app://${host}/${forward}`,
      `app://${host}/${encodeURIComponent(outsideSecretPath)}`,
      `app://${host}/${encodeURIComponent(forward)}`,
      `app://${host}/assets/${encodeURIComponent(outsideSecretPath)}`,
    ];
    for (const url of urls) expectRefused(await requestApp(url));
  });

  // PLT-008, failure mode: an absolute path is refused even when it points inside the renderer output
  it('PLT-008: an absolute path is refused even when it names a file inside the renderer output', async () => {
    const insidePath = join(rendererDir, 'index.html');
    expectRefused(await requestApp(`app://${host}/${encodeURIComponent(insidePath)}`));
    expectRefused(await requestApp(`app://${host}/${toForwardSlashes(insidePath)}`));
  });

  // PLT-008, failure mode: NUL bytes
  it('PLT-008: a path with an encoded NUL byte is refused', async () => {
    expectRefused(await requestApp(`app://${host}/index.html%00.txt`));
    expectRefused(await requestApp(`app://${host}/%00`));
  });

  // PLT-008, failure mode: unknown hosts
  it.each([
    ['another name', 'other-app'],
    ['a longer name that starts with the host', `${host}-evil`],
    ['a subdomain of the host', `evil.${host}`],
    ['the host as a subdomain', `${host}.evil`],
    ['an empty host', ''],
  ])('PLT-008: an unknown host (%s) is refused, even for a file that exists', async (_label, otherHost) => {
    const outcome = await requestApp(`app://${otherHost}/index.html`);
    expectRefused(outcome);
  });

  // Control for the failure modes: the same handler serves the known host.
  it('PLT-008: control: the handler that refused the cases above still serves app://<host>/index.html', async () => {
    const outcome = await requestApp(`app://${host}/index.html`);
    expect(outcome.status, describeOutcome(outcome)).toBe(200);
    expect(outcome.body).toContain('INDEX-MARKER-6f1c');
  });
});
