// Throwaway: TOK-176 / TOK-177 guard. Refuses remote and escaping $refs before Terrazzo loads anything.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function refGuardPlugin({ repoRoot }) {
  return {
    name: "ref-guard",
    enforce: "pre",
    config(config) {
      const seen = new Set();
      const scan = (fileUrl) => {
        const path = fileURLToPath(fileUrl);
        if (seen.has(path)) return;
        seen.add(path);
        const stack = [JSON.parse(readFileSync(path, "utf8"))];
        while (stack.length) {
          const n = stack.pop();
          if (!n || typeof n !== "object") continue;
          for (const [k, v] of Object.entries(n)) {
            if (k === "$ref" && typeof v === "string" && !v.startsWith("#")) {
              if (/^[a-z][a-z0-9+.-]*:/i.test(v)) throw new Error(`${relative(repoRoot, path)}: ref-guard: $ref "${v}" is not a relative path`);
              const target = resolve(dirname(path), v.split("#")[0]);
              if (relative(repoRoot, target).startsWith("..")) throw new Error(`${relative(repoRoot, path)}: ref-guard: $ref "${v}" escapes the repo root`);
              scan(new URL(`file://${target}`));
            } else stack.push(v);
          }
        }
      };
      for (const t of config.tokens) scan(t);
    },
  };
}
