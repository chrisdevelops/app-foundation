// Root Prettier configuration (PLT-006). Every workspace package uses this file.
import type { Config } from 'prettier';

const prettierConfig: Config = {
  printWidth: 120,
  singleQuote: true,
};

export default prettierConfig;
