// Throwaway: does the resolver document still know which file each token came from?
import { parse } from "@terrazzo/parser";
import { evaluate } from "@humanwhocodes/momoa";
import { readFileSync } from "node:fs";

const file = new URL(process.argv[2] ?? "./fixture/foundation/tokens/ui.resolver.json", import.meta.url);
const res = await parse([{ filename: file, src: readFileSync(file, "utf8") }], {
  config: { tokens: [], outDir: new URL("./out/", import.meta.url), plugins: [], alphabetize: true, lint: { build: { enabled: false }, rules: {} }, ignore: { tokens: [], deprecated: false }, permutationLimit: 1000 },
});
const doc = evaluate(res.sources[0].document);
console.log("top keys", Object.keys(doc));
console.log("$defs keys", Object.keys(doc.$defs ?? {}));
console.log(JSON.stringify(doc.sets.components, null, 1).slice(0, 600));
console.log(JSON.stringify(doc.modifiers.theme.contexts.dark, null, 1).slice(0, 700));
