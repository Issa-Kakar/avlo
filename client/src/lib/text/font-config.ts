/**
 * Font Configuration Constants
 *
 * Extracted to a separate file to avoid circular dependencies
 * between font-loader.ts and text-system.ts.
 */

export const FONT_CONFIG = {
  family: 'Grandstander',
  fallback: '"Grandstander", cursive, sans-serif',
  weightNormal: 550,
  weightBold: 800,
  lineHeightMultiplier: 1.3,
} as const;
