import type { ObjectHandle } from '@avlo/shared';
import { getBookmarkProps, getFrame } from '@avlo/shared';
import { getBitmap } from '@/lib/image/image-manager';
import { renderNoteBody } from '@/lib/text/text-system';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BOOKMARK_WIDTH = 360;
const CARD_PADDING = 16;
const MIN_OG_H = 80;
const MAX_OG_H = 300;
const TITLE_FONT_SIZE = 15;
const DESC_FONT_SIZE = 13;
const DOMAIN_FONT_SIZE = 12;
const TITLE_LINE_H = 20;
const DESC_LINE_H = 17;
const TITLE_MAX_LINES = 2;
const DESC_MAX_LINES = 3;
const FAVICON_SIZE = 20;
const CARD_FILL = '#FFFFFF';
const CARD_RADIUS = 8;
const OPEN_BTN_SIZE = 28;
const OPEN_BTN_RADIUS = 6;
const OPEN_BTN_MARGIN = 10;

// ---------------------------------------------------------------------------
// Layout cache
// ---------------------------------------------------------------------------

interface BookmarkLayout {
  titleLines: string[];
  descLines: string[];
  urlLines: string[];
  totalHeight: number;
  hasOgImage: boolean;
  ogDisplayH: number;
}

const layoutCache = new Map<string, BookmarkLayout>();

/** Singleton measurement canvas — never rendered, used for ctx.measureText. */
const measureCtx = (() => {
  const c = new OffscreenCanvas(1, 1);
  return c.getContext('2d')!;
})();

// ---------------------------------------------------------------------------
// Text wrapping helper
// ---------------------------------------------------------------------------

function wrapText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const test = current ? current + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      if (lines.length === maxLines - 1) {
        let truncated = test;
        while (ctx.measureText(truncated + '\u2026').width > maxWidth && truncated.length > 1) {
          truncated = truncated.slice(0, -1);
        }
        lines.push(truncated + '\u2026');
        return lines;
      }
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) {
    if (lines.length === maxLines - 1 && ctx.measureText(current).width > maxWidth) {
      let truncated = current;
      while (ctx.measureText(truncated + '\u2026').width > maxWidth && truncated.length > 1) {
        truncated = truncated.slice(0, -1);
      }
      lines.push(truncated + '\u2026');
    } else {
      lines.push(current);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// OG image display height
// ---------------------------------------------------------------------------

function ogDisplayHeight(ogW: number, ogH: number): number {
  if (ogW <= 0 || ogH <= 0) return 0;
  const natural = BOOKMARK_WIDTH * (ogH / ogW);
  return Math.min(Math.max(natural, MIN_OG_H), MAX_OG_H);
}

// ---------------------------------------------------------------------------
// Layout computation
// ---------------------------------------------------------------------------

function getLayout(
  id: string,
  props: NonNullable<ReturnType<typeof getBookmarkProps>>,
): BookmarkLayout {
  const cached = layoutCache.get(id);
  if (cached) return cached;

  const hasOgImage = !!props.ogImageAssetId && (props.ogImageWidth ?? 0) > 0;
  const ogH = hasOgImage ? ogDisplayHeight(props.ogImageWidth!, props.ogImageHeight!) : 0;
  const textWidth = BOOKMARK_WIDTH - CARD_PADDING * 2;

  measureCtx.font = `bold ${TITLE_FONT_SIZE}px Inter, sans-serif`;
  const titleLines = wrapText(measureCtx, props.title ?? '', textWidth, TITLE_MAX_LINES);

  measureCtx.font = `${DESC_FONT_SIZE}px Inter, sans-serif`;
  const descLines = wrapText(measureCtx, props.description ?? '', textWidth, DESC_MAX_LINES);

  measureCtx.font = `${TITLE_FONT_SIZE}px Inter, sans-serif`;
  const urlLines = !props.title && !hasOgImage ? wrapText(measureCtx, props.url, textWidth, 2) : [];

  const totalHeight = computeLayoutHeight(hasOgImage, ogH, titleLines, descLines, urlLines);

  const layout: BookmarkLayout = {
    titleLines,
    descLines,
    urlLines,
    totalHeight,
    hasOgImage,
    ogDisplayH: ogH,
  };
  layoutCache.set(id, layout);
  return layout;
}

function computeLayoutHeight(
  hasOgImage: boolean,
  ogH: number,
  titleLines: string[],
  descLines: string[],
  urlLines: string[],
): number {
  const titleH = titleLines.length * TITLE_LINE_H;
  const descH = descLines.length * DESC_LINE_H;
  const domainLineH = DOMAIN_FONT_SIZE + 12;

  if (hasOgImage) {
    return ogH + CARD_PADDING + titleH + descH + domainLineH + CARD_PADDING;
  }
  if (titleLines.length > 0) {
    return CARD_PADDING + titleH + descH + domainLineH + CARD_PADDING;
  }
  // Minimal: URL lines + domain
  const urlH = urlLines.length * TITLE_LINE_H;
  return CARD_PADDING + urlH + domainLineH + CARD_PADDING;
}

/** Returns card height based on bookmark metadata. Works with partial unfurl data (no id/cache). */
export function computeBookmarkHeight(data: {
  title?: string;
  description?: string;
  ogImageAssetId?: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
}): number {
  const hasOgImage = !!data.ogImageAssetId && (data.ogImageWidth ?? 0) > 0;
  const ogH = hasOgImage ? ogDisplayHeight(data.ogImageWidth!, data.ogImageHeight!) : 0;
  const textWidth = BOOKMARK_WIDTH - CARD_PADDING * 2;

  measureCtx.font = `bold ${TITLE_FONT_SIZE}px Inter, sans-serif`;
  const titleLines = wrapText(measureCtx, data.title ?? '', textWidth, TITLE_MAX_LINES);

  measureCtx.font = `${DESC_FONT_SIZE}px Inter, sans-serif`;
  const descLines = wrapText(measureCtx, data.description ?? '', textWidth, DESC_MAX_LINES);

  const titleH = titleLines.length * TITLE_LINE_H;
  const descH = descLines.length * DESC_LINE_H;
  const domainLineH = DOMAIN_FONT_SIZE + 12;

  if (hasOgImage) return ogH + CARD_PADDING + titleH + descH + domainLineH + CARD_PADDING;
  if (titleLines.length > 0) return CARD_PADDING + titleH + descH + domainLineH + CARD_PADDING;
  // Minimal
  return CARD_PADDING + TITLE_LINE_H * 2 + domainLineH + CARD_PADDING;
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

export function invalidateBookmarkLayout(id: string): void {
  layoutCache.delete(id);
}

export function clearBookmarkLayouts(): void {
  layoutCache.clear();
}

// ---------------------------------------------------------------------------
// Open-link icon (external arrow, ~10x10wu)
// ---------------------------------------------------------------------------

const openIconPath = new Path2D('M2 1h7v7M9 1L1 9');

// ---------------------------------------------------------------------------
// "Open" button drawing
// ---------------------------------------------------------------------------

function drawOpenButton(ctx: CanvasRenderingContext2D, bx: number, by: number): void {
  // Background rounded rect
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.roundRect(bx, by, OPEN_BTN_SIZE, OPEN_BTN_SIZE, OPEN_BTN_RADIUS);
  ctx.fill();
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Arrow icon centered in button
  const iconSize = 10;
  const iconX = bx + (OPEN_BTN_SIZE - iconSize) / 2;
  const iconY = by + (OPEN_BTN_SIZE - iconSize) / 2;
  ctx.save();
  ctx.translate(iconX, iconY);
  ctx.strokeStyle = '#374151';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(openIconPath);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Draw bookmark — three data-driven layouts
// ---------------------------------------------------------------------------

export function drawBookmark(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const props = getBookmarkProps(handle.y);
  if (!props) return;

  const frame = getFrame(handle.y);
  if (!frame) return;

  const [x, y, w, h] = frame;
  const layout = getLayout(handle.id, props);

  // 1. Shadow + body
  renderNoteBody(ctx, x, y, w, h, CARD_FILL);

  // --- Full card (has OG image + title) ---
  if (layout.hasOgImage && layout.titleLines.length > 0) {
    drawFullCard(ctx, x, y, w, layout, props);
    return;
  }

  // --- Text card (has title, no OG image) ---
  if (layout.titleLines.length > 0) {
    drawTextCard(ctx, x, y, w, layout, props);
    return;
  }

  // --- Minimal card (only url + domain) ---
  drawMinimalCard(ctx, x, y, w, layout, props);
}

// ---------------------------------------------------------------------------
// Full card layout
// ---------------------------------------------------------------------------

function drawFullCard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  layout: BookmarkLayout,
  props: NonNullable<ReturnType<typeof getBookmarkProps>>,
): void {
  let cursorY = y;

  // OG image
  if (props.ogImageAssetId) {
    const bitmap = getBitmap(props.ogImageAssetId);
    const displayH = layout.ogDisplayH;

    if (bitmap) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, w, displayH, [CARD_RADIUS, CARD_RADIUS, 0, 0]);
      ctx.clip();

      const naturalH = w * (bitmap.height / bitmap.width);
      if (naturalH > displayH) {
        // Center-crop vertically
        const scale = w / bitmap.width;
        const srcH = displayH / scale;
        const srcY = (bitmap.height - srcH) / 2;
        ctx.drawImage(bitmap, 0, srcY, bitmap.width, srcH, x, y, w, displayH);
      } else {
        ctx.drawImage(bitmap, x, y, w, displayH);
      }
      ctx.restore();
    } else {
      // Placeholder while bitmap loads
      ctx.fillStyle = '#f5f5f5';
      ctx.beginPath();
      ctx.roundRect(x, y, w, displayH, [CARD_RADIUS, CARD_RADIUS, 0, 0]);
      ctx.fill();
    }

    // "Open" button overlaid on image bottom-right
    drawOpenButton(
      ctx,
      x + w - OPEN_BTN_SIZE - OPEN_BTN_MARGIN,
      y + displayH - OPEN_BTN_SIZE - OPEN_BTN_MARGIN,
    );

    cursorY += displayH;
  }

  cursorY += CARD_PADDING;
  const textX = x + CARD_PADDING;

  // Title
  drawTitleLines(ctx, textX, cursorY, layout.titleLines);
  cursorY += layout.titleLines.length * TITLE_LINE_H;

  // Description
  drawDescLines(ctx, textX, cursorY, layout.descLines);
  cursorY += layout.descLines.length * DESC_LINE_H;

  // Bottom row: favicon + domain (no "Open" button — it's on the image)
  drawBottomRow(ctx, textX, cursorY + 4, w - CARD_PADDING * 2, props, false);
}

// ---------------------------------------------------------------------------
// Text card layout
// ---------------------------------------------------------------------------

function drawTextCard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  layout: BookmarkLayout,
  props: NonNullable<ReturnType<typeof getBookmarkProps>>,
): void {
  let cursorY = y + CARD_PADDING;
  const textX = x + CARD_PADDING;
  const textWidth = w - CARD_PADDING * 2;

  // Title
  drawTitleLines(ctx, textX, cursorY, layout.titleLines);
  cursorY += layout.titleLines.length * TITLE_LINE_H;

  // Description
  drawDescLines(ctx, textX, cursorY, layout.descLines);
  cursorY += layout.descLines.length * DESC_LINE_H;

  // Bottom row: favicon + domain + "Open" button on right
  drawBottomRow(ctx, textX, cursorY + 4, textWidth, props, true);
}

// ---------------------------------------------------------------------------
// Minimal card layout
// ---------------------------------------------------------------------------

function drawMinimalCard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  layout: BookmarkLayout,
  props: NonNullable<ReturnType<typeof getBookmarkProps>>,
): void {
  let cursorY = y + CARD_PADDING;
  const textX = x + CARD_PADDING;
  const textWidth = w - CARD_PADDING * 2;

  // URL text
  ctx.font = `${TITLE_FONT_SIZE}px Inter, sans-serif`;
  ctx.fillStyle = '#1a1a1a';
  ctx.textBaseline = 'top';
  for (const line of layout.urlLines) {
    ctx.fillText(line, textX, cursorY);
    cursorY += TITLE_LINE_H;
  }

  // Domain + "Open" button
  drawBottomRow(ctx, textX, cursorY + 4, textWidth, props, true);
}

// ---------------------------------------------------------------------------
// Shared drawing helpers
// ---------------------------------------------------------------------------

function drawTitleLines(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  lines: string[],
): void {
  if (lines.length === 0) return;
  ctx.font = `bold ${TITLE_FONT_SIZE}px Inter, sans-serif`;
  ctx.fillStyle = '#1a1a1a';
  ctx.textBaseline = 'top';
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += TITLE_LINE_H;
  }
}

function drawDescLines(ctx: CanvasRenderingContext2D, x: number, y: number, lines: string[]): void {
  if (lines.length === 0) return;
  ctx.font = `${DESC_FONT_SIZE}px Inter, sans-serif`;
  ctx.fillStyle = '#6b7280';
  ctx.textBaseline = 'top';
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += DESC_LINE_H;
  }
}

function drawBottomRow(
  ctx: CanvasRenderingContext2D,
  textX: number,
  domainY: number,
  textWidth: number,
  props: NonNullable<ReturnType<typeof getBookmarkProps>>,
  showOpenButton: boolean,
): void {
  let iconX = textX;

  // Favicon
  if (props.faviconAssetId) {
    const favicon = getBitmap(props.faviconAssetId);
    if (favicon) {
      ctx.drawImage(favicon, iconX, domainY, FAVICON_SIZE, FAVICON_SIZE);
      iconX += FAVICON_SIZE + 6;
    }
  }

  // Domain text
  ctx.font = `${DOMAIN_FONT_SIZE}px Inter, sans-serif`;
  ctx.fillStyle = '#9ca3af';
  ctx.textBaseline = 'middle';
  ctx.fillText(props.domain, iconX, domainY + FAVICON_SIZE / 2);

  // "Open" button on the right (when no OG image)
  if (showOpenButton) {
    drawOpenButton(
      ctx,
      textX + textWidth - OPEN_BTN_SIZE,
      domainY + (FAVICON_SIZE - OPEN_BTN_SIZE) / 2,
    );
  }
}
