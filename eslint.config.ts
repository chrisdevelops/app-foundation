// Root ESLint flat config (PLT-006): base rules only. Every workspace package
// runs `eslint .` and resolves this file from the repository root.
// DEFERRED: XC-002 (custom lint rules, including no barrel files and no `export *`; phase 2)
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['**/node_modules/', '**/.turbo/', '**/dist/', '**/generated/'],
  },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The gate helper strips ANSI colour codes, which start with the ESC
    // control character, so the regular expression must contain it.
    files: ['tools/repo/support/run-repo-command.ts'],
    rules: {
      'no-control-regex': 'off',
    },
  },
);
