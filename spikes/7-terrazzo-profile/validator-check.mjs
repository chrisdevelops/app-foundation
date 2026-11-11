// Throwaway: exercises the ADR 0002 item 3 validator and counts how many ways each name parses.
import { nameValidator, parsePrimitiveName } from "#profile";

const validate = nameValidator(); // truthy return = Terrazzo reports an error
const names = [
  "ref.color.ui-ref-color-blue-600",
  "ref.space.ui-ref-space-4",
  "ref.font-family.ui-ref-font-family-ui",
  "ref.color.ui-ref-colour-blue-600", // bad category
  "ref.color.ui-ref-color-600", // valid: no scale
  "ref.color.ui-ref-color", // bad: no step
  "ref.space.ui-ref-space-4-2", // grammar reads scale=4, step=2
  "ref.font-family.ui-ref-font-family-ui-bold", // scale=ui, step=bold
  "ref.border-width.ui-ref-border-width-1",
  "ref.color.ui-ref-color-Blue-600", // case
];
for (const id of names) {
  const leaf = id.split(".").at(-1);
  const parses = parsePrimitiveName(leaf);
  console.log(`${validate(id) ? "REJECT" : "accept"}  parses=${parses.length}  ${leaf}  ${JSON.stringify(parses)}`);
}

// Does any name parse two ways? Enumerate every category-pair for a generic tail.
const ambiguous = [];
for (const a of ["color", "space", "size", "radius", "border-width", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "shadow", "duration", "easing", "z-index", "opacity"])
  for (const tail of ["x", "x-1", "size-md", "family-ui", "width-1", "index-5", "space-4"]) {
    const n = parsePrimitiveName(`ui-ref-${a}-${tail}`).length;
    if (n > 1) ambiguous.push(`ui-ref-${a}-${tail} -> ${n}`);
  }
console.log("names with more than one parse (closed category list):", ambiguous.length ? ambiguous : "none");
