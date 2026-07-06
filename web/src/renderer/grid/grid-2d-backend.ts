/**
 * Canvas2D grid fallback for browsers/drivers without WebGPU (Firefox Linux/Android, Safari < 26,
 * some Linux/AMD Chrome). A single-dot tile repeated via createPattern — O(1) per frame regardless
 * of dot density (a direct dot-by-dot draw would explode to 100k+ arcs near a band promotion).
 * Hard band switch (no crossfade), which the plan accepts for the fallback path.
 *
 * The pattern's setTransform scales an integer-sized tile so its repeat period is EXACTLY the
 * fractional device-px cell — this is what keeps dots glued to their world points across the
 * whole viewport (an integer tile alone would drift and misalign against objects).
 *
 * @module renderer/grid/grid-2d-backend
 */

import type { GridBackend } from './grid-backend';
import { dotRadiusCssForSpacing, finestBandSpacing, GRID } from './grid-params';

const MAX_2D_DIM = 16384; // matches SurfaceManager's canvas cap; camera dpr is already clamped to it

const DOT_COLOR = `rgba(${Math.round(GRID.colorRgb[0] * 255)}, ${Math.round(GRID.colorRgb[1] * 255)}, ${Math.round(GRID.colorRgb[2] * 255)}, ${GRID.alphaMax})`;

function posMod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

class Canvas2DGridBackend implements GridBackend {
  readonly kind = '2d' as const;
  readonly maxDim = MAX_2D_DIM;
  private tile: HTMLCanvasElement | null = null;
  private pattern: CanvasPattern | null = null; // snapshot of `tile` — rebuilt only when the tile is
  private tileSize = 0; // px of the current cached tile (rebuilt when the band's cell rounds differently)
  private tileDpr = 0;
  private readonly matrix = new DOMMatrix(); // reused each frame — zero per-frame allocation

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  /**
   * Return the repeating pattern for this band, rebuilding the single-dot tile + its CanvasPattern
   * only when size/dpr change. Reused across pan frames (a CanvasPattern snapshots the tile at
   * creation, so it only needs recreation when the tile bitmap changes) — no per-frame allocation.
   */
  private ensurePattern(size: number, dpr: number): CanvasPattern | null {
    if (this.pattern && this.tileSize === size && this.tileDpr === dpr) return this.pattern;
    const tile = this.tile ?? document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const tctx = tile.getContext('2d')!;
    tctx.clearRect(0, 0, size, size);
    tctx.fillStyle = DOT_COLOR;
    tctx.beginPath();
    // Radius grows with on-screen spacing past the solo point (size/dpr ≈ CSS spacing), matching the
    // WGSL path. Pure function of (size, dpr) → the (tileSize, tileDpr) cache key stays valid.
    tctx.arc(size / 2, size / 2, dotRadiusCssForSpacing(size / dpr) * dpr, 0, Math.PI * 2);
    tctx.fill();
    this.tile = tile;
    this.tileSize = size;
    this.tileDpr = dpr;
    this.pattern = this.ctx.createPattern(tile, 'repeat');
    return this.pattern;
  }

  render(panX: number, panY: number, scale: number, dpr: number): void {
    const canvas = this.ctx.canvas;
    const w = canvas.width;
    const h = canvas.height;

    const pxPerWorld = scale * dpr;
    const spacing = finestBandSpacing(scale); // world units — hard band switch
    const cell = spacing * pxPerWorld; // device px between dots
    const size = Math.max(1, Math.round(cell)); // integer tile; the pattern scale below fixes the period

    const pattern = this.ensurePattern(size, dpr);

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    if (!pattern) return; // tile had no size (impossible after ensurePattern) — leave transparent

    // Scale the integer tile so its repeat period is exactly `cell`; phase so dot centers land on
    // world lattice points' device positions. Dot centers sit at tile-center → offset by -cell/2.
    const k = cell / size;
    const offX = posMod(-panX * pxPerWorld - cell / 2, cell);
    const offY = posMod(-panY * pxPerWorld - cell / 2, cell);
    this.matrix.a = k;
    this.matrix.b = 0;
    this.matrix.c = 0;
    this.matrix.d = k;
    this.matrix.e = offX;
    this.matrix.f = offY;
    pattern.setTransform(this.matrix);

    this.ctx.fillStyle = pattern;
    this.ctx.fillRect(0, 0, w, h);
  }

  unconfigure(): void {
    // Drop the cached tile + pattern so a re-enable rebuilds them; frees the offscreen bitmap.
    this.tile = null;
    this.pattern = null;
    this.tileSize = 0;
    this.tileDpr = 0;
  }

  destroy(): void {
    this.unconfigure();
  }

  isLost(): boolean {
    return false;
  }
}

/** Build the Canvas2D fallback backend. */
export function createCanvas2DGridBackend(canvas: HTMLCanvasElement): GridBackend {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[grid] Canvas2D context unavailable');
  return new Canvas2DGridBackend(ctx);
}
