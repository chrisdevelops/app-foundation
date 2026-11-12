// The foundation's guard for debugging switches (#18; TST-009, PLT-008;
// ADR 0004 decision 2 B). Apps call `enforcePackagedCdpGuard()` first thing in
// their main process, before `ready`: Chromium opens the DevTools port only
// after `ready` work begins, so a launch that exits here never opens it.
//
// Input: the launch switches, `app.isPackaged` and the environment.
// Output: the launch continues, or the process writes a refusal on stderr and
// exits with `packagedCdpRefusalExitCode`.
// - Packaged build with `--remote-debugging-port`: refused unless
//   `FOUNDATION_ALLOW_PACKAGED_CDP` holds exactly `1`. Any other value (empty,
//   `0`, `false`, ...) refuses, so a stray or half-set variable never opens it.
// - Packaged build with a Node inspector switch (`--inspect`, `--inspect-brk`,
//   `--inspect-port`): always refused. The variable enables only the CDP port;
//   the EnableNodeCliInspectArguments fuse also stops the inspector.
// - Any build with `--remote-debugging-address` other than a loopback address:
//   refused, so the DevTools port listens on localhost only.
// - Dev builds accept `--remote-debugging-port` without the variable.
// The refusal names the switch and the variable on stderr.
// This file is the one definition site of the variable name (CLAUDE.md "one
// name, one definition site"); other code imports `packagedCdpVariableName`.
// DEFERRED: TST-009 (`--remote-debugging-pipe` in packaged builds; #45)
import { writeSync } from 'node:fs';
import { app } from 'electron';

/** Environment variable that lets a packaged build open the CDP port (ADR 0004 decision 2 B). */
export const packagedCdpVariableName = 'FOUNDATION_ALLOW_PACKAGED_CDP';

/** The one value of `packagedCdpVariableName` that enables the CDP port in a packaged build. */
export const packagedCdpEnabledValue = '1';

/** Exit code of a launch the guard refuses. */
const packagedCdpRefusalExitCode = 1;

const remoteDebuggingPortSwitch = 'remote-debugging-port';
const remoteDebuggingAddressSwitch = 'remote-debugging-address';
const nodeInspectorSwitches = ['inspect', 'inspect-brk', 'inspect-port', 'inspect-publish-uid'] as const;
const loopbackAddresses = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** What the guard reads from a launch. */
interface PackagedCdpGuardInput {
  readonly isPackaged: boolean;
  /** Launch switches without the leading `--`, for example `remote-debugging-port`. */
  readonly hasSwitch: (name: string) => boolean;
  readonly getSwitchValue: (name: string) => string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The refusal message for a launch, or undefined when the launch may continue. */
function readPackagedCdpRefusal(input: PackagedCdpGuardInput): string | undefined {
  if (input.hasSwitch(remoteDebuggingAddressSwitch)) {
    const address = input.getSwitchValue(remoteDebuggingAddressSwitch);
    if (!loopbackAddresses.has(address.toLowerCase())) {
      return `Refused --${remoteDebuggingAddressSwitch}=${address}: the DevTools port listens on localhost only.`;
    }
  }
  if (!input.isPackaged) return undefined;
  const inspector = nodeInspectorSwitches.find((name) => input.hasSwitch(name));
  if (inspector !== undefined) {
    return (
      `Refused --${inspector}: a packaged build starts no Node debugger. ` +
      `${packagedCdpVariableName} enables only --${remoteDebuggingPortSwitch}.`
    );
  }
  if (input.hasSwitch(remoteDebuggingPortSwitch) && input.env[packagedCdpVariableName] !== packagedCdpEnabledValue) {
    return (
      `Refused --${remoteDebuggingPortSwitch}: a packaged build opens the DevTools port only when ` +
      `${packagedCdpVariableName}=${packagedCdpEnabledValue} is set in its environment.`
    );
  }
  return undefined;
}

/**
 * Refuses debugging switches this launch may not use (see the file header):
 * removes them, writes the refusal on stderr and exits with
 * `packagedCdpRefusalExitCode`. Call it first in the main process, before `ready`.
 */
export function enforcePackagedCdpGuard(): void {
  const refusal = readPackagedCdpRefusal({
    isPackaged: app.isPackaged,
    hasSwitch: (name) => app.commandLine.hasSwitch(name),
    getSwitchValue: (name) => app.commandLine.getSwitchValue(name),
    env: process.env,
  });
  if (refusal === undefined) return;
  // Belt and braces: Chromium never sees the switches, even if the exit were late.
  for (const name of [remoteDebuggingPortSwitch, remoteDebuggingAddressSwitch, ...nodeInspectorSwitches]) {
    app.commandLine.removeSwitch(name);
  }
  // A synchronous write: process.stderr on a pipe may still be buffered at exit.
  try {
    writeSync(2, `${refusal}\n`);
  } catch {
    // No stderr to write to; the exit code still reports the refusal.
  }
  app.exit(packagedCdpRefusalExitCode);
  process.exit(packagedCdpRefusalExitCode);
}
