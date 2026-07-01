/**
 * Grid tuning + shared lattice math — the single source of truth consumed by both
 * backends (WebGPU + Canvas2D) and future snap-to-grid. Nothing here touches the GPU;
 * the WGSL mirrors these numbers via pipeline-overridable constants (see grid.wgsl),
 * and the 2D fallback + snap use the JS functions directly.
 *
 * @module renderer/grid/grid-params
 */

export const GRID = {
  /** World units between the finest band's dots — the finest visible band + future snap unit. */
  baseSpacing: 10,
  /** Geometric step between bands: 10 → 50 → 250 → 1250 … (dots of a coarser band are a subset). */
  bandRatio: 5,
  /** Finest on-screen spacing (CSS px) allowed before promoting to the next-coarser band. */
  minPxCss: 20,
  /** Dot radius in CSS px (device px = ×dpr). */
  dotRadiusCss: 1.1,
  /** Subtle cool gray, unpremultiplied 0–1 — reads on both #fafafa and a future dark bg. */
  colorRgb: [0x8a / 255, 0x8a / 255, 0x92 / 255] as const,
  /** Peak dot alpha (finest band at full strength). */
  alphaMax: 0.55,
};

const LOG_BAND = Math.log2(GRID.bandRatio);

/**
 * Continuous band level for a css-px-per-world `scale` (0 at the ideal working zoom, rising
 * as you zoom out). `floor(level)` is the finest visible band; the fractional part drives the
 * cross-band fade. Identical to the WGSL's `lvl` so CPU and GPU agree on band boundaries.
 */
export function finestBandLevel(scale: number): number {
  return Math.max(0, Math.log2(GRID.minPxCss / (GRID.baseSpacing * scale)) / LOG_BAND);
}

/** Finest visible band spacing (world units) at a given css-px-per-world `scale`. */
export function finestBandSpacing(scale: number): number {
  return GRID.baseSpacing * GRID.bandRatio ** Math.floor(finestBandLevel(scale));
}

/**
 * Phase-reduce pan into a small range while preserving every visible band's lattice, keeping
 * the shader's `world = pan + frag / pxPerWorld` inside f32's precise range even after panning
 * millions of world units from the origin (raw f32 world coords jitter dots at that distance).
 *
 * The modulus is `baseSpacing · bandRatio^(floor(level)+2)` — divisible by every band the shader
 * can draw (the finest band `l0`, its coarse partner `l0+1`, plus a full band of headroom so a
 * log2 rounding disagreement between CPU and GPU at a boundary can never shift a dot). Subtracting
 * whole periods of that modulus leaves each dot on its exact world point. Writes into `out`
 * (zero-alloc — the loop owns the scratch tuple).
 */
export function reducePanPhase(panX: number, panY: number, scale: number, out: [number, number]): void {
  const l0 = Math.floor(finestBandLevel(scale));
  const m = GRID.baseSpacing * GRID.bandRatio ** (l0 + 2);
  out[0] = panX - Math.floor(panX / m) * m;
  out[1] = panY - Math.floor(panY / m) * m;
}

/**
 * Snap a world point to the grid lattice — CPU only, no GPU readback. Defaults to the finest
 * band (`baseSpacing`); pass `finestBandSpacing(scale)` to snap to whatever band is on-screen.
 */
export function snapWorldToGrid(wx: number, wy: number, spacing = GRID.baseSpacing): [number, number] {
  return [Math.round(wx / spacing) * spacing, Math.round(wy / spacing) * spacing];
}
