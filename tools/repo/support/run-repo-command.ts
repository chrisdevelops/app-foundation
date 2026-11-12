// Test-only helper for the repo gate tests (#12). Runs a command the way a
// developer or CI would, and returns its exit code and combined output.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RepoCommandResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr joined, with ANSI colour codes removed. */
  readonly output: string;
}

/** Absolute path of the repository root (this file is `tools/repo/support/run-repo-command.ts`). */
export const repoGateRootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ansiPattern = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsiCodes(text: string): string {
  return text.replace(ansiPattern, '');
}

// Variables set by an outer pnpm, Turborepo or Vitest process. A nested run
// must not inherit them, or it would behave unlike a developer's shell.
const inheritedVariablePrefixes = ['npm_', 'TURBO_', 'VITEST', 'PNPM_SCRIPT'];
const inheritedVariableNames = ['NODE_ENV', 'TEST', 'INIT_CWD'];

function buildRepoCommandEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (inheritedVariableNames.includes(key)) continue;
    if (inheritedVariablePrefixes.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  env.TURBO_TELEMETRY_DISABLED = '1';
  env.DO_NOT_TRACK = '1';
  env.FORCE_COLOR = '0';
  env.NO_COLOR = '1';
  return { ...env, ...extra };
}

export function runRepoCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
): RepoCommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: buildRepoCommandEnv(options.env),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 300_000,
  });
  const stdout = stripAnsiCodes(result.stdout ?? '');
  const stderr = stripAnsiCodes(result.stderr ?? '');
  const spawnError = result.error ? `\n[spawn error] ${result.error.message}` : '';
  return {
    command: [command, ...args].join(' '),
    exitCode: result.status ?? -1,
    stdout,
    stderr,
    output: `${stdout}\n${stderr}${spawnError}`,
  };
}

/** Formats a result for an assertion message, so a red run shows what the command printed. */
export function describeRepoCommand(result: RepoCommandResult, maxChars = 6000): string {
  const output = result.output.trim();
  const tail = output.length > maxChars ? `...${output.slice(-maxChars)}` : output;
  return `$ ${result.command}\nexit code: ${result.exitCode}\n${tail}`;
}
