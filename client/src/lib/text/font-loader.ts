/**
 * Font Loader
 *
 * Ensures fonts are fully loaded before any measurement or rendering.
 * Uses CSS Font Loading API (document.fonts).
 */

import { FONT_CONFIG } from './font-config';

let fontsLoaded = false;
let loadPromise: Promise<void> | null = null;

/**
 * Ensures Grandstander font is loaded before resolving.
 * Safe to call multiple times - returns cached promise.
 */
export async function ensureFontsLoaded(): Promise<void> {
  if (fontsLoaded) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    // Wait for all CSS fonts to be ready
    await document.fonts.ready;

    // Verify our specific font weights are loaded
    const normalLoaded = document.fonts.check(`${FONT_CONFIG.weightNormal} 16px "${FONT_CONFIG.family}"`);
    const boldLoaded = document.fonts.check(`${FONT_CONFIG.weightBold} 16px "${FONT_CONFIG.family}"`);

    if (!normalLoaded || !boldLoaded) {
      // Force load specific weights
      await Promise.all([
        document.fonts.load(`${FONT_CONFIG.weightNormal} 16px "${FONT_CONFIG.family}"`),
        document.fonts.load(`${FONT_CONFIG.weightBold} 16px "${FONT_CONFIG.family}"`),
        document.fonts.load(`italic ${FONT_CONFIG.weightNormal} 16px "${FONT_CONFIG.family}"`),
        document.fonts.load(`italic ${FONT_CONFIG.weightBold} 16px "${FONT_CONFIG.family}"`),
      ]);
    }

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
