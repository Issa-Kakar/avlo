/**
 * Grid tuning + shared lattice math — the single source of truth consumed by both
 * backends (WebGPU + Canvas2D) and future snap-to-grid. Nothing here touches the GPU;
 * the WGSL mirrors these numbers via pipeline-overridable constants (see grid.wgsl),
 * and the 2D fallback + snap use the JS functions directly.
 *
 * @module renderer/grid/grid-params
 */

export const GRID = {
  /**
   * World units between the finest band's dots — the finest visible band + future snap unit.
   * The finest band sits "solo" (single clean tier, no crossfade) when on-screen spacing hits
   * `minPxCss`, i.e. at `scale = minPxCss / baseSpacing`. With 12 / 20 that lands at ~167% zoom —
   * the middle of the common 150–250% working range — so that band reads cleanest right where you
   * work, and 100% is no longer stuck mid-crossfade (the old 10 anchored the clean band at 200%).
   */
  baseSpacing: 12,
  /** Geometric step between bands: 12 → 60 → 300 … (dots of a coarser band are a subset). */
  bandRatio: 5,
  /** Finest on-screen spacing (CSS px) at which the finest band is solo; below it, cross-fade in the coarser band. */
  minPxCss: 20,
  /**
   * Floor dot radius in CSS px (device px = ×dpr) — held through the whole cross-fade region (all
   * zooms ≤ the solo point). Past the solo point the finest band just spreads with no finer band to
   * reveal, so the radius grows with on-screen spacing (see `dotRadiusCssForSpacing`) up to
   * `dotRadiusMaxCss`, giving the "dots get fatter as you zoom in" feel instead of tiny fixed specks.
   */
  dotRadiusCss: 1.1,
  /** Cap on the zoom-scaled dot radius (CSS px) so far-zoom dots stay dots, not blobs. */
  dotRadiusMaxCss: 2.6,
  /** Subtle cool gray, unpremultiplied 0–1 — reads on both #fafafa and a future dark bg. */
  colorRgb: [0x8a / 255, 0x8a / 255, 0x92 / 255] as const,
  /** Peak dot alpha (finest band at full strength). */
  alphaMax: 0.55,
};

const LOG_BAND = Math.log2(GRID.bandRatio);

/**
 * Dot radius (CSS px) for a given on-screen finest-band spacing. Pinned at `dotRadiusCss` through
 * the cross-fade region (spacing ≤ `minPxCss`) so every band renders identical dots — no radius pop
 * across band promotions — then grows linearly (slope `dotRadiusCss / minPxCss`, continuous at the
 * knee) as the lone finest band spreads past the solo point, capped at `dotRadiusMaxCss`. Mirrored
 * in the WGSL fragment via the DOT_R / DOT_R_MAX / MIN_PX overrides; the 2D fallback calls this.
 */
export function dotRadiusCssForSpacing(fineSpacingCss: number): number {
  const k = GRID.dotRadiusCss / GRID.minPxCss;
  return Math.min(GRID.dotRadiusMaxCss, Math.max(GRID.dotRadiusCss, fineSpacingCss * k));
}

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
