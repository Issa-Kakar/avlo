/**
 * Shadow Bake — analytic gaussian drop-shadow rasterizer.
 *
 * Renders a blurred rounded-rect shadow directly into an ImageData and returns a
 * DPR-sized OffscreenCanvas. It uses NO browser shadow primitive (`ctx.shadowBlur`)
 * and NO `destination-out` punch, so the result is deterministic and bit-identical
 * across engines (Skia Graphite, Skia raster, Firefox). This replaces the old
 * "fill opaque body with shadow, then punch it out" bake, whose `destination-out`
 * left an engine-dependent `c·(1−c)` black residual on anti-aliased edges.
 *
 * Model: a gaussian-blurred straight edge is the gaussian CDF, `0.5 − 0.5·erf(d/(σ√2))`
 * over signed distance `d` (negative inside), which is 1 deep inside, 0.5 on the edge,
 * 0 far outside — exactly what canvas `shadowBlur` produces along straight edges. The
 * canvas blur radius maps as `σ = blur/2`, so shadows tuned against `shadowBlur` carry
 * over unchanged. Corners use the rounded-rect SDF (visually identical to the true 2D
 * convolution for soft shadows), which is exactly translation-invariant along straight
 * edges — the property the bookmark 3-slice relies on.
 *
 * Pure math + one-time per-DPR bake (cached by callers) — off every hot path.
 */

/** One gaussian layer. Blur/offsets in world units; `alpha` is the old shadowColor alpha (0..1). */
export interface ShadowLayer {
  blur: number;
  offsetX: number;
  offsetY: number;
  alpha: number;
}

// Abramowitz & Stegun 7.1.26 rational approximation — |error| ≤ 1.5e-7, ample for 8-bit alpha.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

// Signed distance to a rounded rect centered at (cx,cy), half-extents (hx,hy), corner radius r.
// Negative inside, positive outside. Standard IQ rounded-box SDF.
function sdRoundRect(px: number, py: number, cx: number, cy: number, hx: number, hy: number, r: number): number {
  const dx = Math.abs(px - cx) - (hx - r);
  const dy = Math.abs(py - cy) - (hy - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

/**
 * Bake a two-layer (drop + contact) black shadow of a rounded rect into a DPR-sized
 * OffscreenCanvas. `bake*` sizes and body geometry are in world units; the canvas is
 * `ceil(bake·dpr)` device pixels, sampled at pixel centers. Layers composite
 * contact-over-drop (source-over), matching the drop-first / contact-second fill order
 * of the old bake. RGB stays 0 (black) so straight alpha == premultiplied.
 */
export function bakeRoundRectShadow(
  bakeW: number,
  bakeH: number,
  bodyX: number,
  bodyY: number,
  bodyW: number,
  bodyH: number,
  radius: number,
  drop: ShadowLayer,
  contact: ShadowLayer,
  dpr: number,
): OffscreenCanvas {
  const W = Math.ceil(bakeW * dpr);
  const H = Math.ceil(bakeH * dpr);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const data = img.data;

  const cx = bodyX + bodyW / 2;
  const cy = bodyY + bodyH / 2;
  const hx = bodyW / 2;
  const hy = bodyH / 2;
  const dropDen = (drop.blur / 2) * Math.SQRT2;
  const contactDen = (contact.blur / 2) * Math.SQRT2;

  for (let j = 0; j < H; j++) {
    const py = (j + 0.5) / dpr;
    for (let i = 0; i < W; i++) {
      const px = (i + 0.5) / dpr;
      const aDrop = drop.alpha * (0.5 - 0.5 * erf(sdRoundRect(px - drop.offsetX, py - drop.offsetY, cx, cy, hx, hy, radius) / dropDen));
      const aContact =
        contact.alpha * (0.5 - 0.5 * erf(sdRoundRect(px - contact.offsetX, py - contact.offsetY, cx, cy, hx, hy, radius) / contactDen));
      const a = aContact + aDrop * (1 - aContact);
      data[(j * W + i) * 4 + 3] = Math.round(a * 255);
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}
