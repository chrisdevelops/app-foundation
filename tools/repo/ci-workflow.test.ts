// Behaviour of the CI workflow (#13) that later tasks add. The contract for
// #13 is in ci-workflow.gate.test.ts.
import { test } from 'vitest';

test.todo('CI builds the packaged app and runs the smoke tests on Windows, macOS and Linux (TST-015)');
test.todo('CI runs the drift checks (TOK-151, TOK-152, TOK-153, TOK-154, XC-006)');
test.todo('CI runs the visual tests on one platform (TST-004)');
