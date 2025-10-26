/**
 * Shared Perfect Freehand options, fixed-width (no thinning/pressure).
 * Used by overlay preview (live) and base-canvas (commit).
 */
export const PF_OPTIONS_BASE = {
  // 'size' will be supplied at call-site to match stroke.style.size
  thinning: 0.50,
  smoothing: 0.50,
  streamline: 0.6,
  simulatePressure: true
  
} as const;
