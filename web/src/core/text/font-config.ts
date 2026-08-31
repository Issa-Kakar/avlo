/**
 * Font Configuration Constants
 *
 * Per-family config for multi-font text support.
 * Record key IS the CSS font-family name — zero indirection.
 */

import type { FontFamily } from '../accessors';

export const FONT_WEIGHTS = { normal: 450, bold: 700 } as const;

export interface FontFamilyConfig {
  fallback: string;
  lineHeightMultiplier: number;
}

export const FONT_FAMILIES: Record<FontFamily, FontFamilyConfig> = {
  Grandstander: { fallback: '"Grandstander", cursive, sans-serif', lineHeightMultiplier: 1.3 },
  Inter: { fallback: '"Inter", sans-serif', lineHeightMultiplier: 1.3 },
  Lora: { fallback: '"Lora", serif', lineHeightMultiplier: 1.3 },
  'JetBrains Mono': { fallback: '"JetBrains Mono", monospace', lineHeightMultiplier: 1.3 },
};

// --- Numeric family codes (the text store's per-slot famCode column) ---
// Code === index into FAMILY_LIST. 0xFF is the store's "unset" sentinel, so
// codes must stay < 255. Order is load-bearing: it defines the wire format of
// every famCode stored in text-store columns for the session.

export const FAMILY_LIST: readonly FontFamily[] = ['Grandstander', 'Inter', 'Lora', 'JetBrains Mono'];

const FAMILY_CODES: Record<FontFamily, number> = {
  Grandstander: 0,
  Inter: 1,
  Lora: 2,
  'JetBrains Mono': 3,
};

export function famCodeOf(family: FontFamily): number {
  return FAMILY_CODES[family];
}

/** lineHeightMultiplier by famCode — typed-array mirror of FONT_FAMILIES for hot paths. */
export const LINE_HEIGHT_MULT: Float64Array = (() => {
  const a = new Float64Array(FAMILY_LIST.length);
  for (let i = 0; i < FAMILY_LIST.length; i++) a[i] = FONT_FAMILIES[FAMILY_LIST[i]].lineHeightMultiplier;
  return a;
})();
