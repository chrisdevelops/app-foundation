// Throwaway: profile plugin for spike #7. Lint rules + build outputs, using only documented plugin hooks.
import { evaluate } from "@humanwhocodes/momoa";
import { parse } from "@terrazzo/parser";
import { contrastWCAG21 } from "colorjs.io/fn";
import { tokenToColor as toColor } from "@terrazzo/token-tools";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = "io.github.chrisdevelops.ui";
export const CATEGORIES = ["color", "space", "size", "radius", "border-width", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "shadow", "duration", "easing", "z-index", "opacity"];

// ---------- ADR 0002 item 3: ui-ref-{category}[-{scale}]-{step}
/** Every way a ui-ref name can parse under the closed category list. */
export function parsePrimitiveName(leaf) {
  const m = /^ui-ref-(.+)$/.exec(leaf);
  if (!m) return [];
  const parses = [];
  for (const category of CATEGORIES) {
    if (m[1] !== category && !m[1].startsWith(category + "-")) continue;
    const rest = m[1].slice(category.length + 1).split("-").filter(Boolean); // segments after category
    if (rest.length === 0 || !rest.every((s) => /^[a-z0-9]+$/.test(s))) continue;
    const step = rest.at(-1);
    const scale = rest.slice(0, -1).join("-") || null; // scale may be multi-segment in this reading
    parses.push({ category, scale, step });
  }
  return parses;
}

/** core/consistent-naming validator: receives the dotted token id; TRUTHY RETURN = REPORT AN ERROR. */
export function nameValidator(logFile) {
  return (...args) => {
    if (logFile) appendFileSync(logFile, JSON.stringify(args) + "\n");
    const [id] = args;
    const leaf = id.split(".").at(-1);
    if (!/^[a-z0-9]+(-[a-z0-9]+|__[a-z0-9]+)*$/.test(leaf)) return true;
    if (leaf.startsWith("ui-ref-")) return parsePrimitiveName(leaf).length !== 1;
    return !leaf.startsWith("ui-");
  };
}

// ---------- where did each declaration come from? Read it back from the resolver document's $defs.
export function buildDeclarationIndex(sources) {
  const src = sources[0];
  const resolverPath = fileURLToPath(src.filename);
  const raw = JSON.parse(src.src); // original text: real $ref strings
  const doc = evaluate(src.document); // bundled: $refs rewritten to #/$defs/<key>
  const decls = [];
  const walk = (node, path, onToken) => {
    if (!node || typeof node !== "object") return;
    if ("$value" in node) return onToken(path, node);
    for (const [k, v] of Object.entries(node)) if (!k.startsWith("$")) walk(v, [...path, k], onToken);
  };
  const addSource = (rawSrc, docSrc, container) => {
    const rawRef = rawSrc?.$ref;
    const defsKey = docSrc?.$ref?.replace("#/$defs/", "");
    const tree = defsKey ? doc.$defs[defsKey] : docSrc;
    const file = rawRef ? resolve(dirname(resolverPath), rawRef) : resolverPath;
    walk(tree, [], (path, tok) => decls.push({ id: path.join("."), leaf: path.at(-1), groupPath: path.slice(0, -1), type: tok.$type, value: tok.$value, ext: tok.$extensions?.[EXT], ...container, file }));
  };
  doc.resolutionOrder.forEach((item, order) => {
    const name = item.name ?? item.$ref?.split("/").at(-1);
    if (item.type === "set" || item.$ref?.startsWith("#/sets/")) {
      const key = item.$ref?.split("/").at(-1);
      doc.sets[key].sources.forEach((s, i) => addSource(raw.sets[key].sources[i], s, { kind: "set", name: key, context: null, order }));
    } else {
      const key = item.$ref?.split("/").at(-1);
      for (const [ctx, list] of Object.entries(doc.modifiers[key].contexts))
        list.forEach((s, i) => addSource(raw.modifiers[key].contexts[ctx][i], s, { kind: "modifier", name: key, context: ctx, order }));
    }
  });
  return { decls, resolverPath, repoRoot: dirname(dirname(resolverPath)) };
}

/** Terrazzo's report() prints no file for resolver tokens, so we put TOK-155's shape in the message ourselves. */
const fmt = (decl, repoRoot, ruleId, msg) => `${relative(repoRoot, decl.file)}#${decl.id}: ${ruleId}: ${msg}`;

/** A fresh resolver for per-context checks; lint hooks do not receive one. */
async function loadResolver(sources) {
  const s = sources[0];
  const config = { tokens: [], outDir: new URL("file:///tmp/unused/"), plugins: [], alphabetize: true, lint: { build: { enabled: false }, rules: {} }, ignore: { tokens: [], deprecated: false }, permutationLimit: 1000 };
  return (await parse([{ filename: s.filename, src: s.src }], { config, skipLint: true })).resolver;
}

export function profilePlugin({ outDir = ".", logDir = "logs" } = {}) {
  return {
    name: "profile",
    lint() {
      return {
        "ui/dump-token-fields": {
          // Proof of data available to a custom rule (TOK-138..144 inputs).
          meta: { messages: {} },
          defaultOptions: {},
          create({ tokens, sources, report }) {
            const { decls } = buildDeclarationIndex(sources);
            const t = tokens["color.ui-color-fg-default"];
            const d = decls.filter((x) => x.id === t.id);
            mkdirSync(logDir, { recursive: true });
            writeFileSync(`${logDir}/dump-token-fields.json`, JSON.stringify({
              leafKey: t.id.split(".").at(-1), groupPath: t.group.id, $type: t.$type, aliasOf: t.aliasOf, $extensions: t.$extensions,
              tokenSourceFilename: t.source.filename, tokenSourceHasLineInfo: !!t.source.node?.loc?.start?.line,
              declarations: d.map((x) => ({ file: x.file.split("/").slice(-3).join("/"), kind: x.kind, name: x.name, context: x.context })),
            }, null, 2));
          },
        },
        "ui/unique-leaf-names": {
          meta: { messages: {} },
          defaultOptions: {},
          create({ sources, report }) {
            const { decls, repoRoot } = buildDeclarationIndex(sources);
            const byLeaf = new Map();
            for (const d of decls) byLeaf.set(d.leaf, [...(byLeaf.get(d.leaf) ?? []), d]);
            for (const [leaf, list] of byLeaf) {
              for (let i = 1; i < list.length; i++) {
                const a = list[0], b = list[i];
                const alternatives = a.kind === "modifier" && b.kind === "modifier" && a.name === b.name && a.context !== b.context; // ADR 0002 item 1
                const brandOverride = b.kind === "set" && b.name === "brand" && a.kind === "set" && a.name === "ref"; // brand set overrides ref primitives
                if (alternatives || brandOverride) continue;
                report({ message: fmt(b, repoRoot, "ui/unique-leaf-names", `leaf key "${leaf}" also declared in ${relative(repoRoot, a.file)} (${a.kind} ${a.name}${a.context ? "/" + a.context : ""}); the two are not alternative contexts`) });
              }
            }
          },
        },
        "ui/required-theme-colors": {
          // Replacement for core/required-modes: every semantic colour in every theme context.
          meta: { messages: {} },
          defaultOptions: {},
          async create({ sources, report }) {
            const { decls, repoRoot } = buildDeclarationIndex(sources);
            const theme = decls.filter((d) => d.kind === "modifier" && d.name === "theme");
            const contexts = [...new Set(theme.map((d) => d.context))];
            const semantic = new Set(theme.map((d) => d.leaf));
            for (const leaf of semantic)
              for (const ctx of contexts)
                if (!theme.some((d) => d.context === ctx && d.leaf === leaf)) {
                  const any = theme.find((d) => d.leaf === leaf);
                  report({ message: `${relative(repoRoot, theme.find((d) => d.context === ctx).file)}#${any.id}: ui/required-theme-colors: semantic colour "${leaf}" is missing from theme context "${ctx}"` });
                }
          },
        },
        "ui/min-contrast-per-context": {
          // Replacement for a11y/min-contrast: pairs come from contrastWith, evaluated in every theme context.
          meta: { messages: {} },
          defaultOptions: { minimum: 4.5 },
          async create({ sources, options, report }) {
            const { decls, repoRoot } = buildDeclarationIndex(sources);
            const resolver = await loadResolver(sources);
            for (const input of resolver.listPermutations()) {
              const toks = resolver.apply(input);
              for (const t of Object.values(toks)) {
                const pairs = t.$extensions?.[EXT]?.contrastWith ?? [];
                for (const bgLeaf of pairs) {
                  const bg = Object.values(toks).find((x) => x.id.endsWith("." + bgLeaf));
                  if (!bg) continue;
                  const ratio = contrastWCAG21(toColor(t.$value), toColor(bg.$value));
                  if (ratio < options.minimum) {
                    const d = decls.find((x) => x.id === t.id && (x.context === null || x.context === input[x.name]));
                    report({ message: `${relative(repoRoot, d.file)}#${t.id}: ui/min-contrast-per-context: ${t.id} on ${bgLeaf} is ${ratio.toFixed(2)}:1 in ${JSON.stringify(input)}; need ${options.minimum}:1` });
                  }
                }
              }
            }
          },
        },
        "ui/tier-references": {
          // One working custom rule (TOK-142): reads leaf key, group path, alias target, source file.
          meta: { messages: {} },
          defaultOptions: {},
          create({ tokens, sources, report }) {
            const { decls, repoRoot } = buildDeclarationIndex(sources);
            for (const t of Object.values(tokens)) {
              const leaf = t.id.split(".").at(-1);
              const target = t.originalValue?.$value ?? t.originalValue;
              const alias = typeof t.originalValue === "string" ? t.originalValue : t.aliasOf ? `{${t.aliasOf}}` : null;
              const isComponent = leaf.includes("__");
              const tier = leaf.startsWith("ui-ref-") ? "primitive" : isComponent ? "component" : "semantic";
              const direct = t.aliasChain?.[0]; // direct alias target; aliasOf is the end of the chain
              const aliasTier = direct ? (direct.split(".").at(-1).startsWith("ui-ref-") ? "primitive" : "semantic") : null;
              const bad = (tier === "primitive" && direct) || (tier === "component" && aliasTier !== "semantic");
              if (bad) {
                const d = decls.find((x) => x.id === t.id);
                report({ message: fmt(d, repoRoot, "ui/tier-references", `${tier} token aliases ${aliasTier ?? "nothing"} (${alias})`) });
              }
            }
          },
        },
      };
    },

    // ---------- outputs: tokens.css, token-names.ts, TOKENS.md from the documented build hook
    async build({ tokens, resolver, sources, getTransforms, outputFile }) {
      const { decls, repoRoot } = buildDeclarationIndex(sources);
      const HEADER = "/* GENERATED by tz build. Edit the source *.tokens.json files, never this file. */";
      const fileFor = (id, input) => {
        const cand = decls.filter((d) => d.id === id && (d.kind === "set" || d.context === input[d.name]));
        const d = cand.sort((a, b) => b.order - a.order)[0] ?? cand[0];
        return d ? relative(repoRoot, d.file).replace(/^foundation\//, "") : "unknown";
      };
      const block = (selector, input, filterFn) => {
        const rows = getTransforms({ format: "css", input }).filter((t) => filterFn(t.token.id));
        const body = rows.map((t) => `    ${t.localID}: ${t.value}; /* ${fileFor(t.token.id, input)}#${t.token.id} */`).join("\n");
        return { rows: rows.length, body, selector };
      };
      const inTheme = (ctx) => (id) => decls.some((d) => d.id === id && d.name === "theme" && d.context === ctx);
      const inDensity = (ctx) => (id) => decls.some((d) => d.id === id && d.name === "density" && d.context === ctx);
      const wrap = (sel, body, at) => {
        const inner = `  @layer tokens {\n  ${sel} {\n${body}\n  }\n  }`;
        return at ? `${at} {\n${inner}\n}` : `@layer tokens {\n${sel} {\n${body}\n}\n}`;
      };
      const base = { theme: "light", density: "compact" };
      const out = [HEADER, wrap(":root", block(":root", base, () => true).body)];
      const mq = { dark: "@media (prefers-color-scheme: dark)", "light-high-contrast": "@media (prefers-contrast: more)", "dark-high-contrast": "@media (prefers-color-scheme: dark) and (prefers-contrast: more)" };
      for (const ctx of ["dark", "light-high-contrast", "dark-high-contrast"]) out.push(wrap(":root", block("", { ...base, theme: ctx }, inTheme(ctx)).body, mq[ctx]));
      for (const ctx of ["light", "dark", "light-high-contrast", "dark-high-contrast"]) out.push(wrap(`[data-theme="${ctx}"]`, block("", { ...base, theme: ctx }, inTheme(ctx)).body));
      out.push(wrap(`[data-density="comfortable"]`, block("", { ...base, density: "comfortable" }, inDensity("comfortable")).body));
      outputFile(`${outDir}/tokens.css`, out.join("\n\n") + "\n");

      const names = [...new Set(Object.keys(tokens).map((id) => id.split(".").at(-1)))].sort();
      outputFile(`${outDir}/token-names.ts`, `// GENERATED by tz build. Edit the source *.tokens.json files, never this file.\nexport const uiTokenNames = [\n${names.map((n) => `  "${n}",`).join("\n")}\n] as const;\nexport type UiTokenName = (typeof uiTokenNames)[number];\n`);
      const md = ["<!-- GENERATED by tz build. Edit the source *.tokens.json files, never this file. -->", "| Name | Type | Description | Source |", "| --- | --- | --- | --- |"];
      for (const [id, t] of Object.entries(tokens)) md.push(`| ${id.split(".").at(-1)} | ${t.$type} | ${t.$description} | ${fileFor(id, base)}#${id} |`);
      outputFile(`${outDir}/TOKENS.md`, md.join("\n") + "\n");
    },
  };
}

