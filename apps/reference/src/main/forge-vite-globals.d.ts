// Constants that @electron-forge/plugin-vite defines in the main process bundle
// for the renderer named main_window (forge.config.ts).

/** The Vite dev server URL under `electron-forge start`; undefined in a packaged build. */
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
/** The renderer name, `main_window`: its output folder under .vite/renderer/. */
declare const MAIN_WINDOW_VITE_NAME: string;
