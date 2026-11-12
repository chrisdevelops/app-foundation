// Vite config for the main_window renderer (.vite/renderer/main_window).
// Forge's Vite plugin merges it over its own renderer config.
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // @electron-forge/plugin-vite 8.0.1 sets preserveSymlinks: true for
    // renderers. In pnpm's isolated layout that resolves react-dom's own
    // imports from the symlink path, where its dependencies are not reachable.
    preserveSymlinks: false,
  },
});
