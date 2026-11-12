// Test-only helper for #18 (PLT-008, PLT-012; ADR 0004 decision 9 B). Reads a
// Content-Security-Policy header and lists how it breaks the foundation's
// policy rules. Used by the foundation protocol gate (plain Node) and the
// smoke suite (headers Chromium received in the packaged app).
//
// Rules (issue #18 acceptance criterion 3; ADR 0004 decision 9 B):
// - Scripts are restricted: `script-src` (or `default-src` as its fallback)
//   exists. No script directive (`script-src`, `script-src-elem`,
//   `script-src-attr`, or `default-src` when it is the fallback) holds
//   `'unsafe-inline'` or `'unsafe-eval'`.
// - `style-src` exists and allows `'unsafe-inline'`. It holds no nonce or hash
//   source, because browsers ignore `'unsafe-inline'` when one is present
//   (CSP Level 3). The same holds for `style-src-elem` when it exists.
// - One policy per header (no comma-joined policies), so the rules above read
//   the policy Chromium enforces.

/** Directive name (lower case) to its source list, in the order the header gives them. */
export type ContentSecurityPolicy = ReadonlyMap<string, readonly string[]>;

/** Parses one policy. The first occurrence of a directive wins, as in browsers. */
export function parseContentSecurityPolicy(header: string): ContentSecurityPolicy {
  const policy = new Map<string, string[]>();
  for (const part of header.split(';')) {
    const [name, ...sources] = part
      .trim()
      .split(/\s+/)
      .filter((word) => word !== '');
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (!policy.has(key)) policy.set(key, sources);
  }
  return policy;
}

const scriptDirectives = ['script-src', 'script-src-elem', 'script-src-attr'] as const;
const forbiddenScriptSources = ["'unsafe-inline'", "'unsafe-eval'"] as const;
const nonceOrHashSource = /^'(nonce-|sha256-|sha384-|sha512-)/i;

/** How `header` breaks the foundation's CSP rules; an empty list means it meets them. */
export function listFoundationCspProblems(header: string | null | undefined): string[] {
  if (header === null || header === undefined || header.trim() === '') {
    return ['no Content-Security-Policy header'];
  }
  if (header.includes(',')) return [`one policy per header expected, got several: ${header}`];
  const policy = parseContentSecurityPolicy(header);
  const problems: string[] = [];

  const scriptFallback = policy.has('script-src')
    ? 'script-src'
    : policy.has('default-src')
      ? 'default-src'
      : undefined;
  if (scriptFallback === undefined)
    problems.push('no script-src (and no default-src): inline scripts are not restricted');
  const checkedScriptDirectives = [...scriptDirectives, ...(scriptFallback === 'default-src' ? ['default-src'] : [])];
  for (const directive of checkedScriptDirectives) {
    const sources = (policy.get(directive) ?? []).map((source) => source.toLowerCase());
    for (const forbidden of forbiddenScriptSources) {
      if (sources.includes(forbidden)) problems.push(`${directive} holds ${forbidden}`);
    }
  }

  for (const directive of ['style-src', 'style-src-elem']) {
    const sources = policy.get(directive);
    if (sources === undefined) {
      if (directive === 'style-src') problems.push("no style-src: it must exist and allow 'unsafe-inline'");
      continue;
    }
    const lower = sources.map((source) => source.toLowerCase());
    if (!lower.includes("'unsafe-inline'")) problems.push(`${directive} does not allow 'unsafe-inline'`);
    const ignoredBy = sources.filter((source) => nonceOrHashSource.test(source));
    if (ignoredBy.length > 0) {
      problems.push(`${directive} holds ${ignoredBy.join(' ')}, so browsers ignore its 'unsafe-inline'`);
    }
  }
  return problems;
}
