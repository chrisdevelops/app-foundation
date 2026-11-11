import { defineConfig } from "@terrazzo/cli";
import css from "@terrazzo/plugin-css";
import { resolve } from "node:path";
import { nameValidator, profilePlugin } from "#profile";
import { refGuardPlugin } from "#ref-guard";

// SPIKE_RULES (JSON) overrides or adds lint rules per experiment; SPIKE_CSS=builtin keeps plugin-css's own output.
const extra = JSON.parse(process.env.SPIKE_RULES ?? "{}");
const builtinCss = process.env.SPIKE_CSS === "builtin";
const layer = (sel) => (c) => `@layer tokens {\n${sel} {\n${c}\n}\n}`;
const base = { theme: "light", density: "compact" };

export default defineConfig({
  tokens: ["./tokens/ui.resolver.json"],
  outDir: "./generated/",
  plugins: [
    ...(process.env.SPIKE_GUARD ? [refGuardPlugin({ repoRoot: resolve(process.cwd(), "..") })] : []),
    css({
      filename: builtinCss ? "builtin-tokens.css" : "tokens.css",
      skipBuild: !builtinCss, // our profile plugin writes tokens.css so `__` survives (see findings)
      variableName: (token) => `--${token.id.split(".").at(-1)}`,
      permutations: [
        { input: base, prepare: layer(":root") },
        { input: { ...base, theme: "dark" }, only: { modifiers: ["theme"], sets: ["ref"] }, prepare: (c) => `@media (prefers-color-scheme: dark) {\n@layer tokens {\n:root {\n${c}\n}\n}\n}` },
        { input: { ...base, theme: "light-high-contrast" }, prepare: layer(":root") },
        { input: { ...base, theme: "dark-high-contrast" }, prepare: layer(":root") },
        { input: { ...base, density: "comfortable" }, prepare: layer('[data-density="comfortable"]') },
        // ADR 0002 item 8: same inputs again with a [data-theme] selector, each in @layer tokens.
        ...["light", "dark", "light-high-contrast", "dark-high-contrast"].map((theme) => ({
          input: { ...base, theme },
          only: { modifiers: ["theme"], sets: ["ref", "sys"] },
          prepare: layer(`[data-theme="${theme}"]`),
        })),
      ],
    }),
    profilePlugin({ logDir: "logs" }),
  ],
  lint: {
    rules: {
      "core/required-type": "error",
      "core/descriptions": "error",
      "core/consistent-naming": ["error", { format: nameValidator("logs/validator-input.log") }],
      "core/valid-dimension": ["error", { allowedUnits: ["px", "rem"] }],
      "core/max-gamut": ["error", { gamut: "srgb" }],
      "core/colorspace": ["error", { colorSpace: "oklch" }],
      "ui/dump-token-fields": "warn",
      "ui/unique-leaf-names": "error",
      "ui/required-theme-colors": "error",
      "ui/min-contrast-per-context": "error",
      "ui/tier-references": "error",
      ...extra,
    },
  },
});
