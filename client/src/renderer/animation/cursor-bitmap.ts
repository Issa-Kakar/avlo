/**
 * Cursor Bitmap Cache — pre-render cursor + label as ImageBitmap.
 *
 * One ctx.drawImage() per visible cursor per frame instead of
 * path commands + measureText + roundRect.
 *
 * Cache key: `${color}:${name}`. Fonts are always loaded before
 * canvas exists (main.tsx awaits ensureFontsLoaded).
 */

const cache = new Map<string, ImageBitmap>();

// Rendered on OffscreenCanvas at 2× for retina.
const SCALE = 2;

/**
 * Pointer outline — the IconSelect arrow (see `components/icons/index.tsx`),
 * a filled SVG path in a 24-unit viewBox, reused here verbatim so the peer
 * cursor matches the toolbar's select icon exactly. Reverse-engineered
 * geometry — four vertices, symmetric about the 45° diagonal:
 *   tip    (3.69, 3.69)    hotspot, on the diagonal
 *   notch  (15.72, 15.72)  concave, on the diagonal, recessed ~2.7u toward the tip
 *   wings  (23.82, 11.45) + its mirror (11.45, 23.82), ±8.7u off the axis
 * Every corner is cubic-rounded; the tip carries the largest round.
 */
const SELECT_CURSOR_PATH = new Path2D(
  'm15.533 16.072-2.764 5.243c-.514.974-1.933.895-2.33-.129L5.068 7.264c-.529-1.372.824-2.726 2.196-2.196l13.923 5.372c1.025.396 1.103 1.815.13 2.329l-5.245 2.765c-.23.12-.417.308-.538.538Z',
);
const TIP_VB = 3.689; // tip vertex, viewBox units (x === y — it sits on the diagonal)
const SPAN_VB = 20.13; // tip vertex → far vertex extent, viewBox units

/** viewBox units → CSS px. Lifts the cursor to ~23px — a touch larger, and far wider than before. */
const POINTER_SCALE = 1.15;

// Tip vertex (the hotspot) in the bitmap — also the drawImage offset.
const TIP_X = 3;
const TIP_Y = 3;

/** Pointer's far extent in the bitmap (vertex hull — the rounded path sits inside it). */
const POINTER_MAX = TIP_X + SPAN_VB * POINTER_SCALE;

// Label — rounded rect placed down the pointer's 45° axis from the tip, so
// its convex top-left corner faces the concave notch across a small gap.
const LABEL_FONT_SIZE = 12;
const LABEL_PAD_H = 10;
const LABEL_PAD_V = 5;
const LABEL_RADIUS = 7;
const LABEL_GAP_X = 16; // tip → label corner. X === Y keeps the label corner
const LABEL_GAP_Y = 16; // on the pointer's 45° axis, square-on to the notch.
const LABEL_FONT = `500 ${LABEL_FONT_SIZE}px "Inter", system-ui, sans-serif`;

// Room for the 1px outline bleed on the far / bottom edges of the bitmap.
const EDGE_PAD = 2;

/** Luminance-based text color (WCAG relative luminance). */
function textColorFor(bg: string): string {
  const hex = bg.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.45 ? '#1a1a1a' : '#ffffff';
}

/** Measure label text width using an offscreen canvas. */
function measureLabel(name: string): number {
  const c = new OffscreenCanvas(1, 1);
  const ctx = c.getContext('2d')!;
  ctx.font = LABEL_FONT;
  return ctx.measureText(name).width;
}

function renderBitmap(color: string, name: string): ImageBitmap {
  const textW = measureLabel(name);
  const labelW = textW + LABEL_PAD_H * 2;
  const labelH = LABEL_FONT_SIZE + LABEL_PAD_V * 2;
  const labelX = TIP_X + LABEL_GAP_X;
  const labelY = TIP_Y + LABEL_GAP_Y;

  const totalW = Math.ceil(Math.max(POINTER_MAX, labelX + labelW) + EDGE_PAD);
  const totalH = Math.ceil(Math.max(POINTER_MAX, labelY + labelH) + EDGE_PAD);

  const oc = new OffscreenCanvas(totalW * SCALE, totalH * SCALE);
  const ctx = oc.getContext('2d')!;
  ctx.scale(SCALE, SCALE);

  // --- Label (drawn first — the pointer sits on top) ---
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelW, labelH, LABEL_RADIUS);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = textColorFor(color);
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, labelX + LABEL_PAD_H, labelY + labelH / 2);

  // --- Pointer: the IconSelect arrow, scaled, tip vertex pinned to (TIP_X, TIP_Y) ---
  ctx.save();
  ctx.translate(TIP_X - TIP_VB * POINTER_SCALE, TIP_Y - TIP_VB * POINTER_SCALE);
  ctx.scale(POINTER_SCALE, POINTER_SCALE);
  ctx.fillStyle = color;
  ctx.fill(SELECT_CURSOR_PATH);
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 1 / POINTER_SCALE; // → 1 CSS px after the scale
  ctx.lineJoin = 'round';
  ctx.stroke(SELECT_CURSOR_PATH);
  ctx.restore();

  return oc.transferToImageBitmap();
}

export function getCursorBitmap(color: string, name: string): ImageBitmap {
  const key = `${color}:${name}`;
  let bmp = cache.get(key);
  if (!bmp) {
    bmp = renderBitmap(color, name);
    cache.set(key, bmp);
  }
  return bmp;
}

export function invalidateBitmap(color: string, name: string): void {
  cache.delete(`${color}:${name}`);
}

export function clearBitmapCache(): void {
  cache.clear();
}

/** Bitmap offset: pointer tip vertex is at (TIP_X, TIP_Y) of the bitmap. */
export const CURSOR_BITMAP_OFFSET_X = TIP_X;
export const CURSOR_BITMAP_OFFSET_Y = TIP_Y;
export const CURSOR_BITMAP_SCALE = SCALE;
