/**
 * Font Configuration Constants
 *
 * Per-family config for multi-font text support.
 * Record key IS the CSS font-family name — zero indirection.
 */

import type { FontFamily } from '@/lib/object-accessors';

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
