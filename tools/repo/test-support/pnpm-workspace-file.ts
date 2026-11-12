// Test-only helper for the repo gate tests (#12). Reads settings from
// pnpm-workspace.yaml. Values come from pnpm itself; the raw text is used
// only for what pnpm does not report, such as comments.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeRepoCommand, runRepoCommand } from './run-repo-command';

/** The settings pnpm reads for this workspace, as `pnpm config list --json` reports them. */
export function readPnpmWorkspaceSettings(workspaceRootDir: string): Record<string, unknown> {
  const result = runRepoCommand('pnpm', ['config', 'list', '--json'], { cwd: workspaceRootDir });
  if (result.exitCode !== 0) {
    throw new Error(`pnpm could not read its settings:\n${describeRepoCommand(result)}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

export function readPnpmWorkspaceText(workspaceRootDir: string): string {
  return readFileSync(join(workspaceRootDir, 'pnpm-workspace.yaml'), 'utf8');
}

export interface CommentedYamlEntry {
  readonly value: string;
  readonly lineNumber: number;
  /** Comment on the same line, or on the comment-only line directly above it. */
  readonly comment: string | undefined;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitYamlComment(line: string): { content: string; comment: string | undefined } {
  const match = /(^|\s)#(.*)$/.exec(line);
  if (!match) return { content: line, comment: undefined };
  const comment = (match[2] ?? '').trim();
  return { content: line.slice(0, match.index), comment: comment === '' ? undefined : comment };
}

/**
 * Lists the entries of a top-level YAML sequence key with the comment that
 * belongs to each. Supports block sequences (`- item`) and flow sequences
 * written one entry per line.
 */
export function readCommentedYamlSequence(yamlText: string, key: string): CommentedYamlEntry[] {
  const lines = yamlText.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (keyIndex === -1) return [];
  const entries: CommentedYamlEntry[] = [];
  let previousComment: string | undefined;

  const keyLine = splitYamlComment(lines[keyIndex] ?? '');
  const afterKey = keyLine.content.slice(keyLine.content.indexOf(':') + 1).trim();
  if (afterKey.startsWith('[')) {
    const inline = afterKey.replace(/^\[/, '').replace(/\]\s*$/, '');
    const values = inline
      .split(',')
      .map(unquoteYamlScalar)
      .filter((value) => value !== '');
    if (afterKey.endsWith(']')) {
      return values.map((value) => ({ value, lineNumber: keyIndex + 1, comment: keyLine.comment }));
    }
    for (const value of values) entries.push({ value, lineNumber: keyIndex + 1, comment: keyLine.comment });
  }

  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (/^\S/.test(raw) && !raw.startsWith('#') && !raw.startsWith(']') && !raw.startsWith('-')) break;
    const { content, comment } = splitYamlComment(raw);
    const trimmed = content.trim();
    if (trimmed === '') {
      previousComment = raw.trim() === '' ? undefined : comment;
      continue;
    }
    if (trimmed === ']') break;
    const value = unquoteYamlScalar(trimmed.replace(/^-\s*/, '').replace(/,\s*$/, '').replace(/\]\s*$/, ''));
    if (value !== '') {
      entries.push({ value, lineNumber: index + 1, comment: comment ?? previousComment });
    }
    previousComment = undefined;
    if (trimmed.endsWith(']')) break;
  }
  return entries;
}
