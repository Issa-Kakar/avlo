/**
 * Shared Perfect Freehand options, fixed-width (no thinning/pressure).
 * Used by overlay preview (live) and base-canvas (commit).
 */
export const PF_OPTIONS_BASE = {
  // 'size' will be supplied at call-site to match stroke.style.size
  thinning: 0,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
} as const;
