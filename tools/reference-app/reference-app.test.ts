// Reference app behaviour that later tasks build and test. Each entry matches a
// DEFERRED marker in apps/reference or packages/foundation/src/main.
import { test } from 'vitest';

test.todo(
  'every window reads back contextIsolation, sandbox and nodeIntegration: false from the live window (PLT-008, PLT-012; #18)',
);
test.todo('packaged builds refuse the CDP port unless the environment variable is set (TST-009; #18)');
test.todo('the preload exposes a typed IPC API through contextBridge, validated in main (STA-005, XC-008; #23)');
test.todo('the reference app renders with tokens.css and foundation styling (TOK-112, CMP-003; #19, #21)');
test.todo('the reference app packages a native add-on and runs it from outside the repository (PLT-013; #29)');
test.todo('App Store builds run sandboxed (PLT-011)');
