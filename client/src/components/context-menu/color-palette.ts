/** Sentinel for the "no fill" / "no stroke" option — occupies FILL_PALETTE[0]. */
export const NO_FILL = '__NO_FILL__';

/**
 * Fill + border picker palette — 24 cells, 6 cols × 4 rows, row-major.
 *
 * The toolbar `PALETTE` column-rotated: its rightmost red ramp (light pink /
 * red / dark red, with the empty 4th cell) becomes column 1, and that empty
 * cell relocates to the top-left as the no-fill swatch. Black `#131619` lands
 * at row 1 / col 6.
 */
export const FILL_PALETTE: readonly string[] = [
  NO_FILL,
  '#FFFFFF',
  '#E1E4E8',
  '#ABAFB7',
  '#6B7280',
  '#131619',
  '#FFC0CB',
  '#FFD8B1',
  '#FFEFA6',
  '#C8E6BC',
  '#B5D9F2',
  '#C4B7E2',
  '#FF7370',
  '#FF8A47',
  '#FFC73B',
  '#4CAF50',
  '#2196F3',
  '#9C27B0',
  '#E53030',
  '#8B4513',
  '#A77A2C',
  '#1B5E20',
  '#1F51FF',
  '#6A1B9A',
];
