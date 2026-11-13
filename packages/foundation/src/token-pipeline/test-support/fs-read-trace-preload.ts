// Test-only preload for the token pipeline gates (#20, gate 22; TOK-177).
// Node loads it with `--import` (through NODE_OPTIONS) in every process of a
// token build: pnpm, the shell's `tz build`, and any process the build starts.
// It wraps the public `node:fs` read functions and appends one line per call
// that opens or reads a watched file to a log, so a gate can prove that a
// build refused a `$ref` before it read the file.
//
// Input (environment):
// - TOKEN_GATE_FS_TRACE_PATHS: JSON array of absolute file paths to watch.
// - TOKEN_GATE_FS_TRACE_LOG: absolute path of the log file to append to.
// Output: lines `<function> <absolute path>` in the log file.
//
// Node runs this file with its built-in type stripping, so it uses only
// erasable TypeScript syntax and imports only Node built-ins.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const watchedPathsJson = process.env.TOKEN_GATE_FS_TRACE_PATHS;
const traceLogPath = process.env.TOKEN_GATE_FS_TRACE_LOG;

const normalize = (path: string): string => {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};

/** The absolute path a `node:fs` path argument names, or undefined for a file descriptor or other value. */
function pathOfArgument(value: unknown): string | undefined {
  try {
    if (value instanceof URL) return value.protocol === 'file:' ? fileURLToPath(value) : undefined;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (typeof value === 'string') return value.startsWith('file:') ? fileURLToPath(value) : value;
  } catch {
    return undefined;
  }
  return undefined;
}

if (watchedPathsJson && traceLogPath) {
  const watched = new Set((JSON.parse(watchedPathsJson) as string[]).map(normalize));
  const appendLine = fs.appendFileSync.bind(fs);
  const record = (functionName: string, value: unknown): void => {
    const path = pathOfArgument(value);
    if (path === undefined) return;
    const absolute = normalize(path);
    if (watched.has(absolute)) appendLine(traceLogPath, `${functionName} ${absolute}\n`);
  };

  type AnyFunction = (...args: unknown[]) => unknown;
  const wrap = (target: object, names: readonly string[], prefix: string): void => {
    const table = target as Record<string, AnyFunction | undefined>;
    for (const name of names) {
      const original = table[name];
      if (typeof original !== 'function') continue;
      table[name] = function tracedFsCall(this: unknown, ...args: unknown[]): unknown {
        record(`${prefix}${name}`, args[0]);
        return original.apply(this, args);
      };
    }
  };

  wrap(fs, ['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream', 'openAsBlob'], 'fs.');
  wrap(fsPromises, ['readFile', 'open'], 'fs/promises.');
  // `node:fs/promises` and `fs.promises` are one object; the line above covers both.
  syncBuiltinESMExports();
}
