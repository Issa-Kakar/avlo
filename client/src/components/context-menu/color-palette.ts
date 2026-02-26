/**
 * Context menu color palette — 18 colors (9 columns × 2 rows).
 * Row 1 = solids, Row 2 = matching pastels directly below.
 * Black first (easy reach). Pastel under its solid (cognitive pairing).
 */
export const CONTEXT_MENU_COLORS: readonly string[] = [
  // Row 1: Solids
  '#262626', '#6B7280', '#EF4444', '#F97316', '#FACC15', '#22C55E', '#3B82F6', '#8B5CF6', '#EC4899',
  // Row 2: Pastels (matched below solids)
  '#D1D5DB', '#FFFFFF', '#FEE2E2', '#FFEDD5', '#FEF9C3', '#DCFCE7', '#DBEAFE', '#EDE9FE', '#FCE7F3',
];

/** Sentinel for "no fill" option in fill mode color picker */
export const NO_FILL = '__NO_FILL__';
