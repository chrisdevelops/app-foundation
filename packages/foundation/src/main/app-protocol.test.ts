// app:// handler behaviour that a later task builds and tests (DEFERRED marker in app-protocol.ts).
import { test } from 'vitest';

test.todo("every app:// response carries a CSP with a strict script-src and style-src 'unsafe-inline' (PLT-012; #18)");
