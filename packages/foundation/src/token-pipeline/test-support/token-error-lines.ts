// Test-only reader for token build errors (#20; TOK-155, ADR 0004 decision 6).
// Every error is one line, `file#token.path: rule-id: message`, where `file`
// is relative to the package root with `/` (as in the tokens.css source
// comments, TOK-117), `token.path` is the dotted path inside that file, and
// `rule-id` is `namespace/name`, for example `core/max-gamut`.

/** The strict error line shape. The whole line must match: no prefix such as `✗` or `lint:`. */
export const tokenErrorLinePattern = /^([^\s#:]+)#([^\s:]+): ([a-z0-9-]+(?:\/[a-z0-9-]+)+): (\S.*)$/;

export interface TokenErrorLine {
  readonly line: string;
  readonly file: string;
  readonly tokenPath: string;
  readonly ruleId: string;
  readonly message: string;
}

/** The lines of a command output, with line ends and trailing spaces removed. */
export function outputLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trimEnd());
}

/** Every line of `text` in the strict error shape. */
export function parseTokenErrorLines(text: string): TokenErrorLine[] {
  const errors: TokenErrorLine[] = [];
  for (const line of outputLines(text)) {
    const match = tokenErrorLinePattern.exec(line);
    if (!match) continue;
    const [, file = '', tokenPath = '', ruleId = '', message = ''] = match;
    errors.push({ line, file, tokenPath, ruleId, message });
  }
  return errors;
}

/** Every line of `text` that contains `needle`. */
export function linesContaining(text: string, needle: string): string[] {
  return outputLines(text).filter((line) => line.includes(needle));
}
