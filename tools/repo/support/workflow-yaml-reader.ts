// Test-only helper for the CI workflow gate tests (#13). Reads the YAML subset
// that GitHub Actions workflow files use, without adding a YAML package
// (a new package needs an ADR). Supported: block mappings, block sequences,
// one-line flow sequences and flow mappings of scalars, quoted and plain
// scalars, literal and folded block scalars, and comments. Anything else
// (anchors, aliases, tags, multi-line flow collections, multi-line plain
// scalars, several documents) throws `WorkflowYamlUnsupportedError`, so a
// gate test never passes on a file it misread.

export type WorkflowYamlValue =
  string | number | boolean | null | WorkflowYamlValue[] | { [key: string]: WorkflowYamlValue };

export class WorkflowYamlUnsupportedError extends Error {
  constructor(lineNumber: number, reason: string) {
    super(`workflow YAML line ${lineNumber}: ${reason}`);
    this.name = 'WorkflowYamlUnsupportedError';
  }
}

interface SourceLine {
  readonly number: number;
  /** The raw text of the line, without the line break. */
  raw: string;
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

/** Removes a trailing comment that is outside quotes. */
function stripComment(text: string): string {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") index += 1;
        else quote = undefined;
      } else if (quote === '"' && char === '\\') index += 1;
      continue;
    }
    if ((char === "'" || char === '"') && (index === 0 || /[\s[{,:-]/.test(text[index - 1] ?? ''))) {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(text[index - 1] ?? ''))) return text.slice(0, index).trimEnd();
  }
  return text.trimEnd();
}

function isSignificant(line: SourceLine): boolean {
  return stripComment(line.raw).trim() !== '';
}

/** Index of the `:` that ends a mapping key, or -1. */
function findMappingColon(text: string): number {
  let quote: string | undefined;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") index += 1;
        else quote = undefined;
      } else if (quote === '"' && char === '\\') index += 1;
      continue;
    }
    if ((char === "'" || char === '"') && (index === 0 || /[\s[{,]/.test(text[index - 1] ?? ''))) {
      quote = char;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    if (char === ']' || char === '}') depth -= 1;
    if (char === ':' && depth === 0 && (index === text.length - 1 || text[index + 1] === ' ')) return index;
  }
  return -1;
}

function parseScalar(text: string, lineNumber: number): WorkflowYamlValue {
  const value = text.trim();
  if (value === '') return null;
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new WorkflowYamlUnsupportedError(lineNumber, `unterminated single-quoted scalar: ${value}`);
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new WorkflowYamlUnsupportedError(lineNumber, `unterminated double-quoted scalar: ${value}`);
    }
    return value.slice(1, -1).replace(/\\(.)/g, (_match, escaped: string) => {
      const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0' };
      const replacement = escapes[escaped];
      if (replacement === undefined) {
        throw new WorkflowYamlUnsupportedError(lineNumber, `unsupported escape \\${escaped}`);
      }
      return replacement;
    });
  }
  if (/^[&*!]/.test(value)) {
    throw new WorkflowYamlUnsupportedError(lineNumber, `anchors, aliases and tags are not supported: ${value}`);
  }
  if (value === '|' || value === '>' || /^[|>][-+]?$/.test(value)) {
    throw new WorkflowYamlUnsupportedError(lineNumber, 'block scalar in an unsupported position');
  }
  if (/^(true|True|TRUE)$/.test(value)) return true;
  if (/^(false|False|FALSE)$/.test(value)) return false;
  if (/^(null|Null|NULL|~)$/.test(value)) return null;
  if (/^[-+]?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) return Number.parseFloat(value);
  return value;
}

/** A mapping key as text. Keys are always scalars in the supported subset. */
function yamlKeyText(key: WorkflowYamlValue): string {
  return typeof key === 'object' && key !== null ? JSON.stringify(key) : String(key);
}

function splitFlowItems(inner: string, lineNumber: number): string[] {
  const items: string[] = [];
  let quote: string | undefined;
  let current = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? '';
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    if (char === '[' || char === '{') {
      throw new WorkflowYamlUnsupportedError(lineNumber, 'nested flow collections are not supported');
    }
    if (char === ',') {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') items.push(current.trim());
  return items;
}

function parseInlineValue(text: string, lineNumber: number): WorkflowYamlValue {
  const value = text.trim();
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) {
      throw new WorkflowYamlUnsupportedError(lineNumber, 'multi-line flow sequences are not supported');
    }
    return splitFlowItems(value.slice(1, -1), lineNumber).map((item) => parseScalar(item, lineNumber));
  }
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) {
      throw new WorkflowYamlUnsupportedError(lineNumber, 'multi-line flow mappings are not supported');
    }
    const result: Record<string, WorkflowYamlValue> = {};
    for (const item of splitFlowItems(value.slice(1, -1), lineNumber)) {
      const colon = findMappingColon(item);
      if (colon === -1) throw new WorkflowYamlUnsupportedError(lineNumber, `flow mapping entry without a key: ${item}`);
      result[yamlKeyText(parseScalar(item.slice(0, colon), lineNumber))] = parseScalar(
        item.slice(colon + 1),
        lineNumber,
      );
    }
    return result;
  }
  return parseScalar(value, lineNumber);
}

class WorkflowYamlParser {
  private index = 0;
  private readonly lines: SourceLine[];

  constructor(lines: SourceLine[]) {
    this.lines = lines;
  }

  parseDocument(): WorkflowYamlValue {
    this.skipInsignificant();
    const first = this.lines[this.index];
    if (first && stripComment(first.raw).trim() === '---') {
      this.index += 1;
      this.skipInsignificant();
    }
    const line = this.lines[this.index];
    if (!line) return null;
    const value = this.parseBlock(indentOf(line.raw));
    this.skipInsignificant();
    const rest = this.lines[this.index];
    if (rest) {
      throw new WorkflowYamlUnsupportedError(rest.number, `unexpected content: ${rest.raw.trim()}`);
    }
    return value;
  }

  private skipInsignificant(): void {
    while (this.index < this.lines.length && !isSignificant(this.lines[this.index] as SourceLine)) this.index += 1;
  }

  private peek(): SourceLine | undefined {
    this.skipInsignificant();
    return this.lines[this.index];
  }

  private parseBlock(indent: number): WorkflowYamlValue {
    const line = this.peek();
    if (!line) return null;
    const text = stripComment(line.raw).trim();
    if (text === '---' || text === '...') {
      throw new WorkflowYamlUnsupportedError(line.number, 'several YAML documents are not supported');
    }
    if (text === '-' || text.startsWith('- ')) return this.parseSequence(indent);
    if (findMappingColon(text) !== -1) return this.parseMapping(indent);
    throw new WorkflowYamlUnsupportedError(line.number, `multi-line plain scalars are not supported: ${text}`);
  }

  private parseSequence(indent: number): WorkflowYamlValue[] {
    const items: WorkflowYamlValue[] = [];
    for (let line = this.peek(); line; line = this.peek()) {
      const lineIndent = indentOf(line.raw);
      const text = stripComment(line.raw).trim();
      if (lineIndent < indent) break;
      if (lineIndent > indent) {
        throw new WorkflowYamlUnsupportedError(line.number, `unexpected indentation: ${text}`);
      }
      if (!(text === '-' || text.startsWith('- '))) break;
      const afterDash = line.raw.slice(lineIndent + 1);
      const content = stripComment(afterDash).trim();
      if (content === '') {
        this.index += 1;
        const next = this.peek();
        items.push(next && indentOf(next.raw) > indent ? this.parseBlock(indentOf(next.raw)) : null);
        continue;
      }
      const contentColumn = lineIndent + 1 + indentOf(afterDash);
      if (content === '-' || content.startsWith('- ') || findMappingColon(content) !== -1) {
        // Treat the item as a block that starts at the content column.
        line.raw = ' '.repeat(contentColumn) + line.raw.slice(contentColumn);
        items.push(this.parseBlock(contentColumn));
        continue;
      }
      if (/^[|>]/.test(content)) {
        this.index += 1;
        items.push(this.parseBlockScalar(content, indent, line.number));
        continue;
      }
      this.index += 1;
      items.push(parseInlineValue(content, line.number));
      this.rejectPlainContinuation(indent, line.number);
    }
    return items;
  }

  private parseMapping(indent: number): Record<string, WorkflowYamlValue> {
    const result: Record<string, WorkflowYamlValue> = {};
    for (let line = this.peek(); line; line = this.peek()) {
      const lineIndent = indentOf(line.raw);
      const text = stripComment(line.raw).trim();
      if (lineIndent < indent) break;
      if (lineIndent > indent) {
        throw new WorkflowYamlUnsupportedError(line.number, `unexpected indentation: ${text}`);
      }
      if (text === '-' || text.startsWith('- ')) break;
      if (text.startsWith('? ')) throw new WorkflowYamlUnsupportedError(line.number, 'complex keys are not supported');
      const colon = findMappingColon(text);
      if (colon === -1) throw new WorkflowYamlUnsupportedError(line.number, `expected "key: value": ${text}`);
      const key = yamlKeyText(parseScalar(text.slice(0, colon), line.number));
      if (Object.hasOwn(result, key)) throw new WorkflowYamlUnsupportedError(line.number, `duplicate key "${key}"`);
      const valueText = text.slice(colon + 1).trim();
      this.index += 1;
      if (valueText === '') {
        const next = this.peek();
        if (next && indentOf(next.raw) > indent) {
          result[key] = this.parseBlock(indentOf(next.raw));
        } else if (next && indentOf(next.raw) === indent && /^-( |$)/.test(stripComment(next.raw).trim())) {
          result[key] = this.parseSequence(indent);
        } else {
          result[key] = null;
        }
        continue;
      }
      if (/^[|>]/.test(valueText)) {
        result[key] = this.parseBlockScalar(valueText, indent, line.number);
        continue;
      }
      result[key] = parseInlineValue(valueText, line.number);
      this.rejectPlainContinuation(indent, line.number);
    }
    return result;
  }

  private rejectPlainContinuation(parentIndent: number, lineNumber: number): void {
    const next = this.peek();
    if (next && indentOf(next.raw) > parentIndent && !/^-( |$)/.test(stripComment(next.raw).trim())) {
      throw new WorkflowYamlUnsupportedError(
        next.number,
        `multi-line plain scalars are not supported (value starts on line ${lineNumber})`,
      );
    }
  }

  private parseBlockScalar(header: string, parentIndent: number, lineNumber: number): string {
    const match = /^([|>])([-+]?)$/.exec(header);
    if (!match) throw new WorkflowYamlUnsupportedError(lineNumber, `unsupported block scalar header: ${header}`);
    const [, style, chomping] = match;
    const body: string[] = [];
    let contentIndent: number | undefined;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index] as SourceLine;
      if (line.raw.trim() === '') {
        body.push('');
        this.index += 1;
        continue;
      }
      const lineIndent = indentOf(line.raw);
      if (lineIndent <= parentIndent) break;
      contentIndent ??= lineIndent;
      if (lineIndent < contentIndent) break;
      body.push(line.raw.slice(contentIndent));
      this.index += 1;
    }
    // Trailing blank lines belong to the chomping rule, and the parser must
    // look at them again as insignificant lines of the parent.
    let trailingBlank = 0;
    while (body.length > 0 && body[body.length - 1] === '') {
      body.pop();
      trailingBlank += 1;
    }
    let text: string;
    if (style === '|') {
      text = body.join('\n');
    } else {
      text = '';
      for (let index = 0; index < body.length; index += 1) {
        const current = body[index] ?? '';
        const previous = body[index - 1];
        if (index === 0) text = current;
        else if (current === '') text += '\n';
        else if (previous === '') text += current;
        else if (/^\s/.test(current) || /^\s/.test(previous ?? '')) text += '\n' + current;
        else text += ' ' + current;
      }
    }
    if (body.length === 0) return '';
    if (chomping === '-') return text;
    if (chomping === '+') return text + '\n'.repeat(trailingBlank + 1);
    return text + '\n';
  }
}

/** Parses the text of a workflow file. Throws `WorkflowYamlUnsupportedError` on YAML it cannot read safely. */
export function parseWorkflowYaml(text: string): WorkflowYamlValue {
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)
    .map((raw, index): SourceLine => {
      if (raw.includes('\t') && /^\s*\t/.test(raw)) {
        throw new WorkflowYamlUnsupportedError(index + 1, 'tabs are not allowed for indentation');
      }
      return { number: index + 1, raw };
    });
  return new WorkflowYamlParser(lines).parseDocument();
}
