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

// Cursor dimensions (CSS pixels, rendered at 2× for retina)
const SCALE = 2;
const POINTER_H = 18;
const LABEL_FONT_SIZE = 12;
const LABEL_PAD_H = 8;
const LABEL_PAD_V = 3;
const LABEL_GAP_X = 6;
const LABEL_GAP_Y = 16;
const LABEL_FONT = `500 ${LABEL_FONT_SIZE}px "Inter", system-ui, sans-serif`;

// Pointer tip offset — slight left bias so hotspot aligns naturally
const TIP_X = 1;
const TIP_Y = 1;

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

  const totalW = Math.ceil(Math.max(TIP_X + POINTER_H, TIP_X + LABEL_GAP_X + labelW) + 2);
  const totalH = Math.ceil(TIP_Y + POINTER_H + LABEL_GAP_Y + labelH + 2);

  const oc = new OffscreenCanvas(totalW * SCALE, totalH * SCALE);
  const ctx = oc.getContext('2d')!;
  ctx.scale(SCALE, SCALE);

  // --- Pointer (Figma-style) ---
  ctx.beginPath();
  ctx.moveTo(TIP_X, TIP_Y);
  ctx.lineTo(TIP_X, TIP_Y + POINTER_H);
  ctx.lineTo(TIP_X + 4.5, TIP_Y + POINTER_H - 3.5);
  ctx.lineTo(TIP_X + 11, TIP_Y + POINTER_H - 7);
  ctx.closePath();

  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // --- Label pill ---
  const lx = TIP_X + LABEL_GAP_X;
  const ly = TIP_Y + LABEL_GAP_Y;
  const radius = labelH / 2;

  ctx.beginPath();
  ctx.roundRect(lx, ly, labelW, labelH, radius);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Label text
  ctx.fillStyle = textColorFor(color);
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  ctx.fillText(name, lx + LABEL_PAD_H, ly + labelH / 2);

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

/** Bitmap offset: pointer tip is at (TIP_X, TIP_Y) of the bitmap. */
export const CURSOR_BITMAP_OFFSET_X = TIP_X;
export const CURSOR_BITMAP_OFFSET_Y = TIP_Y;
export const CURSOR_BITMAP_SCALE = SCALE;
