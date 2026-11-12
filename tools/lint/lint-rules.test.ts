// Lint behaviour that #12 deliberately leaves out. The root ESLint config has
// base rules only (PLT-006); the custom rules come in phase 2.
import { test } from 'vitest';

test.todo('lint rejects barrel files and `export *` re-exports (XC-002)');
