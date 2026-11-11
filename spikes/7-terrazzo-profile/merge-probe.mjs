// Throwaway: what does Terrazzo do when one leaf key is declared twice? Usage: node merge-probe.mjs <resolver.json> <token id> <json input>
import { parse } from "@terrazzo/parser";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [file, id, inputJson] = process.argv.slice(2);
const filename = pathToFileURL(resolve(file));
const config = { tokens: [], outDir: new URL("file:///tmp/unused/"), plugins: [], alphabetize: true, lint: { build: { enabled: false }, rules: {} }, ignore: { tokens: [], deprecated: false }, permutationLimit: 1000 };
const { resolver } = await parse([{ filename, src: readFileSync(filename, "utf8") }], { config });
const t = resolver.apply(JSON.parse(inputJson))[id];
console.log(JSON.stringify({ id, input: JSON.parse(inputJson), value: t.$value, description: t.$description }));
