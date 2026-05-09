// 24-color palette laid out as a 6×4 grid in the popover (row-major).
// Source: Mural's zoom-menu color picker reference (zoommenustroke.png).
export const PALETTE: readonly string[] = [
  // Row 1 — grays + coral accent
  '#FFFFFF',
  '#E1E4E8',
  '#ABAFB7',
  '#6B7280',
  '#131619',
  '#FFB0A1',
  // Row 2 — pastels
  '#FFD8B1',
  '#FFEFA6',
  '#C8E6BC',
  '#B5D9F2',
  '#C4B7E2',
  '#FF8FB1',
  // Row 3 — vivids
  '#FF8A47',
  '#FFC73B',
  '#4CAF50',
  '#2196F3',
  '#9C27B0',
  '#F44336',
  // Row 4 — darks
  '#8B4513',
  '#A77A2C',
  '#1B5E20',
  '#1F51FF',
  '#4A148C',
  '#B71C1C',
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
