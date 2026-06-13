/** Parse '#RRGGBB' (leading '#' optional) into a packed 24-bit int. */
function hexToInt(hex: string): number {
  return Number.parseInt(hex.charCodeAt(0) === 35 ? hex.slice(1) : hex, 16);
}

/** Nearest palette entry to `hex` by sRGB Euclidean distance. */
export function nearestPaletteColor(hex: string, palette: readonly string[]): string {
  const v = hexToInt(hex);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  let best = palette[0];
  let bestD = Infinity;
  for (const p of palette) {
    const pv = hexToInt(p);
    const dr = ((pv >> 16) & 0xff) - r;
    const dg = ((pv >> 8) & 0xff) - g;
    const db = (pv & 0xff) - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
