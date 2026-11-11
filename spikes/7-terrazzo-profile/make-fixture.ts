// Throwaway: writes the fixture token system in the spec's layout. Run: node make-fixture.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EXT = "io.github.chrisdevelops.ui";
const root = new URL("./fixture/", import.meta.url).pathname;

function write(rel: string, data: unknown) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

const oklch = (l: number, c: number, h: number) => ({ colorSpace: "oklch", components: [l, c, h] });
const color = (value: unknown, description: string, extra: Record<string, unknown> = {}) => ({
  $type: "color", $value: value, $description: description, ...extra,
});
const dim = (value: number, unit: "rem" | "px", description: string) => ({
  $type: "dimension", $value: { value, unit }, $description: description,
});
const sem = (alias: string, description: string, ext: Record<string, unknown> = { usage: "Spike usage." }) => ({
  $type: "color", $value: alias, $description: description, $extensions: { [EXT]: ext },
});

// --- foundation/tokens/ref
const refColor = {
  ref: { color: {
    "ui-ref-color-gray-50": color(oklch(0.98, 0.003, 250), "Lightest gray."),
    "ui-ref-color-gray-900": color(oklch(0.22, 0.01, 250), "Darkest gray."),
    "ui-ref-color-gray-950": color(oklch(0.14, 0.01, 250), "Near black."),
    "ui-ref-color-blue-600": color(oklch(0.55, 0.2, 260), "Mid blue."),
    "ui-ref-color-brand-100": color(oklch(0.92, 0.03, 260), "Brand light step."),
    "ui-ref-color-brand-600": color(oklch(0.52, 0.19, 260), "Brand mid step."),
    "ui-ref-color-brand-900": color(oklch(0.3, 0.1, 260), "Brand dark step."),
  } },
};
write("foundation/tokens/ref/color.tokens.json", refColor);
write("foundation/tokens/ref/space.tokens.json", { ref: { space: {
  "ui-ref-space-4": dim(0.25, "rem", "Space step 4."),
  "ui-ref-space-6": dim(0.375, "rem", "Space step 6."),
} } });
write("foundation/tokens/ref/font.tokens.json", { ref: { "font-family": {
  "ui-ref-font-family-ui": { $type: "fontFamily", $value: ["system-ui", "sans-serif"], $description: "UI font stack." },
  "ui-ref-font-family-mono": { $type: "fontFamily", $value: ["ui-monospace", "monospace"], $description: "Mono font stack." },
} } });
write("foundation/tokens/ref/motion.tokens.json", { ref: { duration: {
  "ui-ref-duration-fast": { $type: "duration", $value: { value: 100, unit: "ms" }, $description: "Fast duration." },
} } });
write("foundation/tokens/sys/base.tokens.json", { radius: {
  "ui-radius-control-default": { $type: "dimension", $value: { value: 0.25, unit: "rem" }, $description: "Control corner radius.", $extensions: { [EXT]: { usage: "Buttons and inputs." } } },
} });

// --- themes: same three semantic colours in each file
const themes: Record<string, { bg: string; fg: string; accent: string }> = {
  light: { bg: "gray-50", fg: "gray-900", accent: "brand-600" },
  dark: { bg: "gray-950", fg: "gray-50", accent: "brand-100" },
  "light-high-contrast": { bg: "gray-50", fg: "gray-950", accent: "brand-900" },
  "dark-high-contrast": { bg: "gray-950", fg: "gray-50", accent: "brand-100" },
};
for (const [name, t] of Object.entries(themes)) {
  const a = (s: string) => `{ref.color.ui-ref-color-${s}}`;
  const group: Record<string, unknown> = {
    "ui-color-bg-default": sem(a(t.bg), "Default surface."),
    "ui-color-fg-default": sem(a(t.fg), "Body text.", { usage: "Body text.", contrastWith: ["ui-color-bg-default"] }),
    "ui-color-bg-accent-default": sem(a(t.accent), "Accent background."),
  };
  write(`foundation/tokens/theme/${name}.tokens.json`, { color: group });
}
write("foundation/tokens/density/compact.tokens.json", { space: {
  "ui-space-inset-control-default": { $type: "dimension", $value: "{ref.space.ui-ref-space-4}", $description: "Control padding.", $extensions: { [EXT]: { usage: "Control padding." } } },
} });
write("foundation/tokens/density/comfortable.tokens.json", { space: {
  "ui-space-inset-control-default": { $type: "dimension", $value: "{ref.space.ui-ref-space-6}", $description: "Control padding.", $extensions: { [EXT]: { usage: "Control padding." } } },
} });
write("foundation/src/components/button/button.tokens.json", { button: {
  "ui-button__color-bg-primary-default": { $type: "color", $value: "{color.ui-color-bg-accent-default}", $description: "Primary button background.", $extensions: { [EXT]: { usage: "Primary button." } } },
} });

const fr = (p: string) => ({ $ref: p });
write("foundation/tokens/ui.resolver.json", {
  name: "UI Foundation", version: "2025.10",
  sets: {
    ref: { sources: ["color", "space", "font", "motion"].map((n) => fr(`ref/${n}.tokens.json`)) },
    sys: { sources: [fr("sys/base.tokens.json")] },
    components: { sources: [fr("../src/components/button/button.tokens.json")] },
  },
  modifiers: {
    theme: { contexts: Object.fromEntries(Object.keys(themes).map((n) => [n, [fr(`theme/${n}.tokens.json`)]])), default: "light" },
    density: { contexts: { compact: [fr("density/compact.tokens.json")], comfortable: [fr("density/comfortable.tokens.json")] }, default: "compact" },
  },
  resolutionOrder: [fr("#/sets/ref"), fr("#/sets/sys"), fr("#/modifiers/theme"), fr("#/modifiers/density"), fr("#/sets/components")],
});

// --- app: brand set overriding brand primitives; refs reach the foundation outside the app's tokens/
write("apps/demo/tokens/brand.tokens.json", { ref: { color: {
  "ui-ref-color-brand-100": color(oklch(0.9, 0.06, 150), "Brand light step."),
  "ui-ref-color-brand-600": color(oklch(0.5, 0.11, 150), "Brand mid step."),
  "ui-ref-color-brand-900": color(oklch(0.3, 0.08, 150), "Brand dark step."),
} } });
const F = "../../../foundation/tokens/";
write("apps/demo/tokens/app.resolver.json", {
  name: "Demo app", version: "2025.10",
  sets: {
    ref: { sources: ["color", "space", "font", "motion"].map((n) => fr(`${F}ref/${n}.tokens.json`)) },
    brand: { sources: [fr("brand.tokens.json")] },
    sys: { sources: [fr(`${F}sys/base.tokens.json`)] },
    components: { sources: [fr(`${F}../src/components/button/button.tokens.json`)] },
  },
  modifiers: {
    theme: { contexts: Object.fromEntries(Object.keys(themes).map((n) => [n, [fr(`${F}theme/${n}.tokens.json`)]])), default: "light" },
    density: { contexts: { compact: [fr(`${F}density/compact.tokens.json`)], comfortable: [fr(`${F}density/comfortable.tokens.json`)] }, default: "compact" },
  },
  resolutionOrder: [fr("#/sets/ref"), fr("#/sets/brand"), fr("#/sets/sys"), fr("#/modifiers/theme"), fr("#/modifiers/density"), fr("#/sets/components")],
});
