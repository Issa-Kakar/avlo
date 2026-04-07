/**
 * Font Loader
 *
 * Ensures all text fonts are fully loaded before any measurement or rendering.
 * Uses CSS Font Loading API (document.fonts).
 */

import { FONT_WEIGHTS, FONT_FAMILIES } from './font-config';

let fontsLoaded = false;
let loadPromise: Promise<void> | null = null;

/**
 * Ensures all font families are loaded before resolving.
 * Safe to call multiple times - returns cached promise.
 */
export async function ensureFontsLoaded(): Promise<void> {
  if (fontsLoaded) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    await document.fonts.ready;

    const loads: Promise<FontFace[]>[] = [];
    for (const family of Object.keys(FONT_FAMILIES)) {
      const q = `"${family}"`;
      if (!document.fonts.check(`${FONT_WEIGHTS.normal} 16px ${q}`) || !document.fonts.check(`${FONT_WEIGHTS.bold} 16px ${q}`)) {
        loads.push(
          document.fonts.load(`${FONT_WEIGHTS.normal} 16px ${q}`),
          document.fonts.load(`${FONT_WEIGHTS.bold} 16px ${q}`),
          document.fonts.load(`italic ${FONT_WEIGHTS.normal} 16px ${q}`),
          document.fonts.load(`italic ${FONT_WEIGHTS.bold} 16px ${q}`),
        );
      }
    }

    if (loads.length > 0) await Promise.all(loads);

    fontsLoaded = true;
    // eslint-disable-next-line no-console
    console.log('[font-loader] Fonts loaded successfully');
  })();

  return loadPromise;
}

/**
 * Synchronous check - only reliable after ensureFontsLoaded() resolves.
 */
export function areFontsLoaded(): boolean {
  return fontsLoaded;
}
