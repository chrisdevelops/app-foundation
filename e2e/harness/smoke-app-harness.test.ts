// Smoke harness behaviour that later tasks add. Each entry matches a DEFERRED
// marker in e2e/. The contract for #16 is in smoke-app-harness.gate.test.ts.
import { test } from 'vitest';

test.todo('packaged builds refuse the CDP port unless a test build enables it (TST-009; #18)');
test.todo('CI runs the smoke suite against the packaged app on Windows, macOS and Linux (TST-010; #17)');
