// Vite config for the main_window renderer (.vite/renderer/main_window).
// Forge's Vite plugin merges it over its own renderer config.
import { defineConfig, type Plugin } from 'vite';

/**
 * Drops the page reload that @electron-forge/plugin-vite 8.0.1 sends after its
 * first preload build, before any page has connected (#46; TST-018).
 *
 * The plugin sends `{ type: 'full-reload' }` (no `path`) to every renderer dev
 * server each time the preload bundle is built, the first build included. At
 * that moment no page is open, so Vite buffers the message and replays it to
 * the first page that connects: every dev launch loaded the window twice
 * (`navigationType` "reload"). On Linux under xvfb, a background-mode window
 * then intermittently ran no requestAnimationFrame for several seconds after
 * that reload (PR #47 CI). The first preload build always finishes before
 * Electron starts, so no page can hold an older preload, and the reload has
 * nothing to refresh.
 *
 * Only that message is dropped, and only until the first page connects. Every
 * reload Vite sends itself carries a `path`; preload rebuilds after a page has
 * connected still reload it.
 */
function dropForgeInitialPreloadReload(): Plugin {
  const isForgePreloadReload = (payload: unknown): boolean =>
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    payload.type === 'full-reload' &&
    !('path' in payload);
  return {
    name: 'reference:drop-forge-initial-preload-reload',
    apply: 'serve',
    configureServer(server) {
      let pageConnected = false;
      server.ws.on('connection', () => {
        pageConnected = true;
      });
      const viteSend = server.ws.send.bind(server.ws);
      server.ws.send = (...args: unknown[]): void => {
        if (!pageConnected && isForgePreloadReload(args[0])) return;
        Reflect.apply(viteSend, undefined, args);
      };
    },
  };
}

export default defineConfig({
  plugins: [dropForgeInitialPreloadReload()],
  resolve: {
    // @electron-forge/plugin-vite 8.0.1 sets preserveSymlinks: true for
    // renderers. In pnpm's isolated layout that resolves react-dom's own
    // imports from the symlink path, where its dependencies are not reachable.
    preserveSymlinks: false,
  },
});
