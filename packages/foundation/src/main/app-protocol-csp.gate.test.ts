// Gate tests for #18: the Content-Security-Policy on every `app://` response
// (PLT-008, PLT-012; ADR 0004 decisions 1 A and 9 B).
//
// Contract (input and output), on top of the #15 handler contract in
// app-protocol.gate.test.ts:
// - `createAppProtocolHandler({ host, rendererDir })` from
//   `packages/foundation/src/main/app-protocol.ts` returns a handler whose
//   every Response, served (200) or refused (4xx), carries a
//   `Content-Security-Policy` header.
// - That policy meets the foundation rules in
//   tools/test-support/content-security-policy.ts: `script-src` without
//   `'unsafe-inline'` and `'unsafe-eval'`; `style-src` with `'unsafe-inline'`
//   and no nonce or hash (ADR 0004 decision 9 B).
// - A refusal that rejects, or answers `Response.error()`, gives Chromium no
//   page at all, so it needs no header (the #15 contract allows both).
// The smoke suite (e2e/smoke/security-baseline.smoke.test.ts) reads the same
// header from Chromium in the packaged app and checks what it does.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listFoundationCspProblems } from '../../../../tools/test-support/content-security-policy';

type AppProtocolHandler = (request: Request) => Promise<Response>;

interface AppProtocolModule {
  readonly createAppProtocolHandler: (options: { host: string; rendererDir: string }) => AppProtocolHandler;
}

const appProtocolModuleUrl = new URL('./app-protocol.ts', import.meta.url).href;

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

const host = 'rf-csp-gate';
let baseDir = '';
let rendererDir = '';
let handler: AppProtocolHandler | undefined;

function writeFixtureFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(() => {
  baseDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'app-protocol-csp-gate-')));
  rendererDir = join(baseDir, 'renderer');
  writeFixtureFile(join(rendererDir, 'main_window', 'index.html'), '<!doctype html><title>csp gate</title>');
  writeFixtureFile(join(rendererDir, 'main_window', 'assets', 'index-abc123.js'), 'export {};\n');
  writeFixtureFile(join(rendererDir, 'main_window', 'assets', 'index-abc123.css'), 'p { color: red; }\n');
  writeFixtureFile(join(rendererDir, 'main_window', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFixtureFile(join(baseDir, 'secret.txt'), 'outside');
});

afterAll(() => {
  if (baseDir) rmSync(baseDir, { recursive: true, force: true });
});

async function handlerUnderTest(): Promise<AppProtocolHandler> {
  if (!handler) {
    const { createAppProtocolHandler } = await loadAppProtocolModule();
    handler = createAppProtocolHandler({ host, rendererDir });
  }
  return handler;
}

interface CspOutcome {
  readonly url: string;
  /** False when the handler rejected or answered Response.error(): no page reaches Chromium. */
  readonly answered: boolean;
  readonly status: number;
  readonly csp: string | null;
}

async function requestCsp(url: string): Promise<CspOutcome> {
  const handle = await handlerUnderTest();
  try {
    const response = await handle(new Request(url));
    if (response.type === 'error') return { url, answered: false, status: 0, csp: null };
    return { url, answered: true, status: response.status, csp: response.headers.get('content-security-policy') };
  } catch {
    return { url, answered: false, status: 0, csp: null };
  }
}

const servedCases: ReadonlyArray<[string, string]> = [
  ['the HTML page', 'main_window/index.html'],
  ['a module script', 'main_window/assets/index-abc123.js'],
  ['a stylesheet', 'main_window/assets/index-abc123.css'],
  ['an image', 'main_window/logo.svg'],
];

const refusedCases: ReadonlyArray<[string, string]> = [
  ['a missing file (404)', `app://${host}/main_window/missing.html`],
  ['a folder (404)', `app://${host}/main_window`],
  ['another host (403)', `app://rf-csp-gate-other/main_window/index.html`],
  ['an encoded traversal', `app://${host}/main_window/%2e%2e/%2e%2e/secret.txt`],
];

describe('app:// Content-Security-Policy header (PLT-008; ADR 0004 decision 9 B)', () => {
  // PLT-008; issue #18 acceptance criterion 3: every app:// response
  it.each(servedCases)(
    'PLT-008: a served app:// response for %s carries a Content-Security-Policy header',
    async (_label, path) => {
      const outcome = await requestCsp(`app://${host}/${path}`);
      expect(outcome.status, `control: ${outcome.url} must be served`).toBe(200);
      expect(outcome.csp, `${outcome.url} must carry a Content-Security-Policy header`).toBeTruthy();
    },
  );

  // PLT-008; issue #18 acceptance criterion 3 (failure modes answer with a response too)
  it.each(refusedCases)(
    'PLT-008: a refused app:// response for %s carries a Content-Security-Policy header when it answers',
    async (_label, url) => {
      const outcome = await requestCsp(url);
      expect(outcome.status === 200, `${url} must be refused, got ${outcome.status}`).toBe(false);
      if (!outcome.answered) return;
      expect(outcome.csp, `${url} answered ${outcome.status} without a Content-Security-Policy header`).toBeTruthy();
    },
  );

  // PLT-008; ADR 0004 decision 9 B: script-src strict, style-src allows inline styles
  it.each([...servedCases.map(([label, path]): [string, string] => [label, `app://${host}/${path}`]), ...refusedCases])(
    "PLT-008: the policy on the response for %s has no 'unsafe-inline' or 'unsafe-eval' for scripts and allows 'unsafe-inline' for styles",
    async (_label, url) => {
      const outcome = await requestCsp(url);
      if (!outcome.answered) return;
      expect(listFoundationCspProblems(outcome.csp), `${url} -> ${outcome.status}, CSP ${String(outcome.csp)}`).toEqual(
        [],
      );
    },
  );
});
