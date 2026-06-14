// Palette for the picker grid (6 cols, row-major). 23 entries, not 24: the last
// grid cell is intentionally empty. The shape fill picker will prepend a "none"
// swatch, shifting all 23 up to land on a clean 6×4; pickers without a "none"
// (pen, connector) show 6+6+6+5 until then.
// The rightmost column is its own red ramp — a light pink, a clean red, a
// dark red kept clear of the row-4 darks; its 4th cell is the empty one.
// Source: Mural's zoom-menu color picker reference (zoommenustroke.png).
export const PALETTE: readonly string[] = [
  // Row 1 — grays + ramp: light pink
  '#FFFFFF',
  '#E1E4E8',
  '#ABAFB7',
  '#6B7280',
  '#131619',
  '#FFC0CB',
  // Row 2 — pastels + ramp: red
  '#FFD8B1',
  '#FFEFA6',
  '#C8E6BC',
  '#B5D9F2',
  '#C4B7E2',
  '#FF7370',
  // Row 3 — vivids + ramp: dark red
  '#FF8A47',
  '#FFC73B',
  '#4CAF50',
  '#2196F3',
  '#9C27B0',
  '#E53030',
  // Row 4 — darks (rightmost cell intentionally empty)
  '#8B4513',
  '#A77A2C',
  '#1B5E20',
  '#1F51FF',
  '#6A1B9A',
];

export const PALETTE_COLS = 6;

/**
 * Perceptual luminance of a hex color (sRGB Rec. 709 coefficients).
 * Returns [0, 1]; values < ~0.55 are "dark" → use a white checkmark.
 */
export function luminance(hex: string): number {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const v =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  if (v.length !== 6) return 0;
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Returns 'black' or 'white' to give the checkmark maximum contrast. */
export function checkmarkColorFor(hex: string): '#000' | '#FFF' {
  return luminance(hex) > 0.55 ? '#000' : '#FFF';
}

/** True for colors that visually blend with the dark dock background
 * (#101720 has luminance ~0.05). Used to add a white inner outline so
 * the slot rect's edges remain readable. */
export function isDark(hex: string): boolean {
  return luminance(hex) < 0.25;
}

/** Stricter than isDark: true only for near-black colors whose fill is nearly
 * indistinguishable from the dock background itself (#101720, luminance ~0.09).
 * The picker popout uses this — only black needs a visible contrast border;
 * mid-darks like dark purple/red separate from the dock on fill alone. */
export function isNearBlack(hex: string): boolean {
  return luminance(hex) < 0.13;
}

/** Case-insensitive hex equality (handles '#abc' vs '#aabbcc' too). */
export function colorsEqual(a: string, b: string): boolean {
  const norm = (h: string) => {
    const v = h.startsWith('#') ? h.slice(1) : h;
    const expanded =
      v.length === 3
        ? v
            .split('')
            .map((c) => c + c)
            .join('')
        : v;
    return expanded.toLowerCase();
  };
  return norm(a) === norm(b);
}
