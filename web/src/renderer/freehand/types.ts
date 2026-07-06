/** One raw input point: `[x, y]` or `[x, y, pressure]` (pressure optional, default 1). */
export type StrokeInputPoint = readonly number[];

/**
 * Baseline pen/highlighter geometry. `thinning:0` + `simulatePressure:false` keep the radius
 * a constant `size/2`, which is what makes the stroke bbox padding (`width/2 + 1`) exact.
 * `streamline` is a free tunable now that the pipeline — not this value — is responsible for
 * smoothness.
 */
export const STROKE_OPTIONS_BASE = {
  thinning: 0,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
} as const;
