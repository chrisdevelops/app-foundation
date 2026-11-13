// Test-only colour check for the foundation token gate (#19; TOK-135,
// ADR 0004 decision 7). Converts an OKLCH colour to linear sRGB with the
// published OKLab matrices (Björn Ottosson, "A perceptual color space for
// image processing", 2020) and reports whether it lies inside sRGB.

/** Small tolerance for rounding at the edge of the gamut. */
const gamutEpsilon = 1e-4;

/** Linear sRGB channels of an OKLCH colour (`l` 0 to 1, `c` chroma, `h` hue in degrees). */
export function oklchToLinearSrgb(l: number, c: number, h: number): [number, number, number] {
  const hue = (h * Math.PI) / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b;
  const lms = [lPrime ** 3, mPrime ** 3, sPrime ** 3] as const;
  return [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ];
}

/** True when the OKLCH colour can be shown in sRGB without clipping. */
export function isOklchInsideSrgb(l: number, c: number, h: number): boolean {
  return oklchToLinearSrgb(l, c, h).every((channel) => channel >= -gamutEpsilon && channel <= 1 + gamutEpsilon);
}
