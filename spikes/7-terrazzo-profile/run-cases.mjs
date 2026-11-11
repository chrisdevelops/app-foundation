// Throwaway: copies the fixture, mutates it, runs `tz build`, records exit code and output in evidence/<case>.txt
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const tz = join(here, "node_modules/.bin/tz");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const editJson = (p, fn) => { const j = readJson(p); fn(j); writeFileSync(p, JSON.stringify(j, null, 2) + "\n"); };
const only = process.argv[2];

const cases = {
  "baseline": { note: "valid fixture, all rules", mutate() {} },
  "bad-name": { note: "ui-ref-colour-blue-600 breaks the grammar", mutate(r) {
    editJson(join(r, "foundation/tokens/ref/color.tokens.json"), (j) => { j.ref.color["ui-ref-colour-blue-600"] = j.ref.color["ui-ref-color-blue-600"]; }); } },
  "required-modes-builtin-dark": { note: "dark theme lacks ui-color-fg-default; built-in core/required-modes asks for mode 'dark'", mutate: missingFromDark,
    rules: { "core/required-modes": ["error", { matches: [{ match: ["color.*"], modes: ["dark"] }] }] } },
  "required-modes-builtin-dot": { note: "same fixture; built-in core/required-modes with mode '.' (the only mode a resolver token has)", mutate: missingFromDark,
    rules: { "core/required-modes": ["error", { matches: [{ match: ["color.*"], modes: ["."] }] }] } },
  "required-modes-off": { note: "same fixture, only our ui/required-theme-colors", mutate: missingFromDark },
  "contrast-dark-fails": { note: "dark fg is gray-900 on gray-950; core pair is static", mutate(r) {
    editJson(join(r, "foundation/tokens/theme/dark.tokens.json"), (j) => { j.color["ui-color-fg-default"].$value = "{ref.color.ui-ref-color-gray-900}"; }); },
    rules: { "a11y/min-contrast": ["error", { level: "AA", pairs: [{ foreground: "color.ui-color-fg-default", background: "color.ui-color-bg-default" }] }] } },
  "dup-leaf-not-alternatives": { note: "ui-radius-control-default also declared in density/compact (not an alternative of sys/base)", mutate(r) {
    editJson(join(r, "foundation/tokens/density/compact.tokens.json"), (j) => { j.radius = { "ui-radius-control-default": { $type: "dimension", $value: { value: 0.5, unit: "rem" }, $description: "dup", $extensions: { "io.github.chrisdevelops.ui": { usage: "dup" } } } }; }); },
    rules: { "ui/unique-leaf-names": "off" } },
  "dup-leaf-ours": { note: "same fixture with our ui/unique-leaf-names on", mutate(r) {
    editJson(join(r, "foundation/tokens/density/compact.tokens.json"), (j) => { j.radius = { "ui-radius-control-default": { $type: "dimension", $value: { value: 0.5, unit: "rem" }, $description: "dup", $extensions: { "io.github.chrisdevelops.ui": { usage: "dup" } } } }; }); } },
  "tier-bad": { note: "component aliases a primitive", mutate(r) {
    editJson(join(r, "foundation/src/components/button/button.tokens.json"), (j) => { j.button["ui-button__color-bg-primary-default"].$value = "{ref.color.ui-ref-color-blue-600}"; }); } },
  "wide-gamut-max-gamut-gamut": { note: "out-of-sRGB colour; max-gamut with documented-table option `gamut: srgb`", mutate: wide,
    rules: { "core/colorspace": "off", "core/max-gamut": ["error", { gamut: "srgb" }] } },
  "wide-gamut-max-gamut-format": { note: "same; max-gamut with the docs' example option `format: srgb`", mutate: wide,
    rules: { "core/colorspace": "off", "core/max-gamut": ["error", { format: "srgb" }] } },
  "wide-gamut-max-gamut-p3": { note: "same; gamut p3", mutate: wide,
    rules: { "core/colorspace": "off", "core/max-gamut": ["error", { gamut: "p3" }] } },
  "wide-gamut-builtin-css": { note: "plugin-css own output for a P3-only colour", mutate: wide, env: { SPIKE_CSS: "builtin" },
    rules: { "core/colorspace": "off", "core/max-gamut": "off" } },
  "display-p3-authored": { note: "colour authored with colorSpace display-p3 (colorspace rule off, max-gamut off)", mutate(r) {
    editJson(join(r, "foundation/tokens/ref/color.tokens.json"), (j) => { j.ref.color["ui-ref-color-blue-600"].$value = { colorSpace: "display-p3", components: [0, 0.6, 1] }; }); },
    rules: { "core/colorspace": "off", "core/max-gamut": ["error", { gamut: "p3" }] } },
  "colorspace-srgb-required": { note: "core/colorspace colorSpace: srgb against oklch tokens (negative control)", mutate() {},
    rules: { "core/colorspace": ["error", { colorSpace: "srgb" }] } },
  "app-brand": { note: "app resolver: foundation files via ../../foundation/..., brand set after ref", mutate() {}, sub: "apps/demo" },
  "builtin-css": { note: "plugin-css own permutations output for the valid fixture", mutate() {}, env: { SPIKE_CSS: "builtin" } },
  "ref-remote-url": { note: "resolver $ref to http://127.0.0.1 (local stand-in for a remote URL)", mutate(r) {
    editJson(join(r, "foundation/tokens/ui.resolver.json"), (j) => { j.sets.ref.sources.push({ $ref: "http://127.0.0.1:" + process.env.SPIKE_PORT + "/remote.tokens.json" }); }); }, needsServer: true },
  "ref-escapes-root": { note: "resolver $ref to a file outside the case root", mutate(r) {
    writeFileSync(join(r, "../outside.tokens.json"), JSON.stringify({ ref: { color: { "ui-ref-color-outside-1": { $type: "color", $value: { colorSpace: "oklch", components: [0.5, 0.1, 10] }, $description: "outside the repo root" } } } }));
    editJson(join(r, "foundation/tokens/ui.resolver.json"), (j) => { j.sets.ref.sources.push({ $ref: "../../../outside.tokens.json" }); }); } },
  "ref-guard-remote": { note: "remote $ref with our ref guard on", mutate(r) {
    editJson(join(r, "foundation/tokens/ui.resolver.json"), (j) => { j.sets.ref.sources.push({ $ref: "http://127.0.0.1:" + process.env.SPIKE_PORT + "/remote.tokens.json" }); }); }, env: { SPIKE_GUARD: "1" }, needsServer: true },
  "ref-guard-escape": { note: "escaping $ref with our ref guard on", mutate(r) {
    writeFileSync(join(r, "../outside.tokens.json"), "{}");
    editJson(join(r, "foundation/tokens/ui.resolver.json"), (j) => { j.sets.ref.sources.push({ $ref: "../../../outside.tokens.json" }); }); }, env: { SPIKE_GUARD: "1" } },
};

function missingFromDark(r) {
  editJson(join(r, "foundation/tokens/theme/dark.tokens.json"), (j) => { delete j.color["ui-color-fg-default"]; });
}
function wide(r) {
  editJson(join(r, "foundation/tokens/ref/color.tokens.json"), (j) => { j.ref.color["ui-ref-color-blue-600"].$value = { colorSpace: "oklch", components: [0.6, 0.2, 255] }; });
}

mkdirSync(join(here, "evidence"), { recursive: true });
const { createServer } = await import("node:http");
let server;
const port = await new Promise((res) => { server = createServer((q, s) => { console.log("SERVER HIT", q.url); writeFileSync(join(here, "evidence", "remote-server-hit.txt"), `HIT ${q.url}\n`); s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ ref: { color: { "ui-ref-color-remote-1": { $type: "color", $value: { colorSpace: "oklch", components: [0.5, 0.1, 10] }, $description: "served remotely" } } } })); }).listen(0, "127.0.0.1", () => res(server.address().port)); });
process.env.SPIKE_PORT = String(port);

for (const [name, c] of Object.entries(cases)) {
  if (only && only !== name) continue;
  const root = join(here, "cases", name, "fixture");
  rmSync(join(here, "cases", name), { recursive: true, force: true });
  mkdirSync(join(here, "cases", name), { recursive: true });
  cpSync(join(here, "fixture"), root, { recursive: true, filter: (s) => !/\/(generated|logs)(\/|$)/.test(s) });
  c.mutate(root);
  const cwd = join(root, c.sub ?? "foundation");
  const env = { ...process.env, ...(c.env ?? {}), SPIKE_RULES: JSON.stringify(c.rules ?? {}) };
  const r = await new Promise((res) => execFile(tz, ["build"], { cwd, env, encoding: "utf8", timeout: 30000 }, (err, stdout, stderr) => res({ status: err ? (err.code ?? "signal:" + err.signal) : 0, stdout, stderr })));
  const out = `case: ${name}\nnote: ${c.note}\ncommand: tz build   (cwd cases/${name}/fixture/${c.sub ?? "foundation"}, SPIKE_RULES=${env.SPIKE_RULES})\nexit: ${r.status}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}`;
  writeFileSync(join(here, "evidence", `${name}.txt`), out);
  try { cpSync(join(cwd, "generated"), join(here, "evidence", `${name}.generated`), { recursive: true }); } catch {}
  console.log(`${name}: exit ${r.status}`);
}
server.close();
