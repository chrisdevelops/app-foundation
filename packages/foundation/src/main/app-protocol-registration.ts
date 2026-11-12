// Electron side of the foundation's `app://` protocol (#15; PLT-008; ADR 0004
// decision 1 A). Apps call `registerAppProtocolScheme` before `ready` and
// `handleAppProtocol` after it; the handler itself is in `app-protocol.ts`.
import { protocol } from 'electron';
import { appProtocolScheme, createAppProtocolHandler, type AppProtocolHandlerOptions } from './app-protocol';

/**
 * Registers `app` as a privileged scheme: standard (a real origin and
 * relative URLs) and secure (a secure context). Must run before the app
 * `ready` event; Electron throws when it runs later.
 */
export function registerAppProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: appProtocolScheme, privileges: { standard: true, secure: true } }]);
}

/** Serves `app://<host>/...` from `rendererDir` in the default session. Call after `ready`. */
export function handleAppProtocol(options: AppProtocolHandlerOptions): void {
  protocol.handle(appProtocolScheme, createAppProtocolHandler(options));
}

/** The `app://` URL of a file in the renderer output, for example `appProtocolUrl('rf', 'main_window/index.html')`. */
export function appProtocolUrl(host: string, path: string): string {
  return `${appProtocolScheme}://${host}/${path.replace(/^\/+/, '')}`;
}
