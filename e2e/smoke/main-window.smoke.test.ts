// First smoke test (#16; TST-007, TST-010): the reference app starts with
// exactly one main window and the expected title. Runs against the dev build,
// or against the packaged executable named by SMOKE_APP_EXECUTABLE; in
// packaged mode the window URL must start with app:// (PLT-008, ADR 0004
// decision 1). Driven by Playwright over CDP through the smoke harness.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  loadSmokeHarness,
  type ExpectedSmokeApp,
  type ExpectedSmokeAppTarget,
} from '../test-support/smoke-harness-contract';
import {
  smokeHarnessDeferredOnWindows,
  smokeHarnessWindowsDeferralReason,
} from '../test-support/windows-smoke-deferral';

/** The reference app's window title (apps/reference: main window title and index.html <title>). */
const referenceAppTitle = 'Reference';
/** Time the window list must stay unchanged before it counts as settled. */
const windowSettleMs = 1_500;

let app: ExpectedSmokeApp | undefined;
let target: ExpectedSmokeAppTarget | undefined;

async function settledWindowTitles(started: ExpectedSmokeApp, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let lastKey = '';
  let stableSince = Date.now();
  let titles: string[] = [];
  while (Date.now() < deadline) {
    titles = await Promise.all(started.windows().map((page) => page.title().catch(() => '')));
    const key = JSON.stringify(titles);
    if (key !== lastKey) {
      lastKey = key;
      stableSince = Date.now();
    }
    if (titles.length > 0 && titles.every((title) => title !== '') && Date.now() - stableSince >= windowSettleMs) {
      return titles;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no settled app window within ${timeoutMs} ms; last titles ${JSON.stringify(titles)}`);
}

// DEFERRED: TST-010 (Windows smoke suite; ADR 0011, #39): no launch and every test skips on Windows.
beforeEach((context) => {
  if (smokeHarnessDeferredOnWindows) context.skip(smokeHarnessWindowsDeferralReason);
});

beforeAll(async () => {
  if (smokeHarnessDeferredOnWindows) return;
  const harness = await loadSmokeHarness();
  target = harness.resolveSmokeAppTarget(process.env);
  app = await harness.launchSmokeApp({ target });
}, 300_000);

afterAll(async () => {
  await app?.teardown();
}, 120_000);

describe(`reference app main window`, () => {
  // TST-010; issue #16 acceptance criterion 9
  it('TST-010: the app starts with exactly one main window titled "Reference"', { timeout: 180_000 }, async () => {
    if (!app) throw new Error('the app did not start');
    const titles = await settledWindowTitles(app, 120_000);
    expect(titles, `windows: ${JSON.stringify(app.windows().map((page) => page.url()))}`).toEqual([referenceAppTitle]);
  });

  // PLT-008, TST-010; issue #16 acceptance criterion 9: in packaged mode the URL starts with app://
  it('TST-010: in packaged mode the main window URL starts with app://', { timeout: 180_000 }, async (context) => {
    if (target?.kind !== 'packaged') {
      context.skip('dev build: the window loads the Vite dev server');
      return;
    }
    if (!app) throw new Error('the app did not start');
    await settledWindowTitles(app, 120_000);
    expect(app.windows().map((page) => page.url())).toEqual([expect.stringMatching(/^app:\/\//)]);
  });
});
