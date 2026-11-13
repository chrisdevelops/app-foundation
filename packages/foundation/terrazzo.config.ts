// `tz build` in packages/foundation writes generated/tokens.css (TOK-111,
// TOK-112). Paths are relative to this package and plugins are imported by
// package name, so the config also works when copied beside other token files
// (issue #19 reading R1).
import { tokenProfileCssPluginOptions, tokenProfilePlugin } from '@foundation/config/token-profile-plugin';
import { defineConfig } from '@terrazzo/cli';
import css from '@terrazzo/plugin-css';

export default defineConfig({
  tokens: ['./tokens/ui.resolver.json'],
  outDir: './generated/',
  plugins: [css(tokenProfileCssPluginOptions), tokenProfilePlugin({ packageRoot: new URL('./', import.meta.url) })],
});
