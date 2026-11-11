// Throwaway: find oklch values that are outside sRGB but inside P3.
import { inGamut } from "colorjs.io/fn";
import { tokenToColor } from "@terrazzo/token-tools";

for (const c of [[0.62, 0.24, 255], [0.6, 0.2, 255], [0.7, 0.22, 150], [0.55, 0.2, 260], [0.65, 0.26, 145]]) {
  const col = tokenToColor({ colorSpace: "oklch", components: c, alpha: 1 });
  console.log(c.join(","), "srgb", inGamut(col, "srgb"), "p3", inGamut(col, "p3"), "rec2020", inGamut(col, "rec2020"));
}
