import type { ObjectHandle, BookmarkProps } from '../types/objects';
import type { BBoxTuple, FrameTuple } from '../types/geometry';
import { getBookmarkProps } from '../accessors';
import { getBitmap } from '../image/image-manager';
import { renderNoteBody } from '../text/sticky-note';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BOOKMARK_WIDTH = 300;
const CARD_PADDING = 14;
const MIN_OG_H = 70;
const MAX_OG_H = 250;
const TITLE_FONT_SIZE = 14;
const DESC_FONT_SIZE = 12;
const DOMAIN_FONT_SIZE = 11;
const TITLE_LINE_H = 19;
const DESC_LINE_H = 16;
const TITLE_MAX_LINES = 2;
const DESC_MAX_LINES = 3;
const FAVICON_SIZE = 18;
const CARD_FILL = '#FFFFFF';
const CARD_RADIUS = 8;
const OPEN_BTN_W = 78;
const OPEN_BTN_H = 28;
const OPEN_BTN_RADIUS = 6;
const OPEN_BTN_MARGIN = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BookmarkHoverTarget = 'button' | 'link';

export interface LocalRect {
  lx: number;
  ly: number;
  lw: number;
  lh: number;
}

// ---------------------------------------------------------------------------
// Layout cache
// ---------------------------------------------------------------------------

interface BookmarkLayout {
  titleLines: string[];
  descLines: string[];
  totalHeight: number;
  hasOgImage: boolean;
  ogDisplayH: number;
  domainTextWidth: number;
}

const layoutCache = new Map<string, BookmarkLayout>();
const bookmarkFrameCache = new Map<string, FrameTuple>();

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

function ogDisplayHeight(ogW: number, ogH: number, cardWidth: number): number {
  if (ogW <= 0 || ogH <= 0) return MIN_OG_H;
  const natural = cardWidth * (ogH / ogW);
  return Math.min(Math.max(natural, MIN_OG_H), MAX_OG_H);
}

// ---------------------------------------------------------------------------
// Layout computation
// ---------------------------------------------------------------------------

function getLayout(
  id: string,
  props: NonNullable<ReturnType<typeof getBookmarkProps>>,
  cardWidth: number = BOOKMARK_WIDTH,
): BookmarkLayout {
  const cached = layoutCache.get(id);
  if (cached) return cached;

  const hasOgImage = !!props.ogImageAssetId;
  const ogH = hasOgImage ? ogDisplayHeight(props.ogImageWidth ?? 0, props.ogImageHeight ?? 0, cardWidth) : 0;
  const textWidth = cardWidth - CARD_PADDING * 2;

  measureCtx.font = `bold ${TITLE_FONT_SIZE}px Inter, sans-serif`;
  const titleLines = wrapText(measureCtx, props.title ?? '', textWidth, TITLE_MAX_LINES);

  measureCtx.font = `${DESC_FONT_SIZE}px Inter, sans-serif`;
  const descLines = wrapText(measureCtx, props.description ?? '', textWidth, DESC_MAX_LINES);

  measureCtx.font = `${DOMAIN_FONT_SIZE}px Inter, sans-serif`;
  const domainTextWidth = measureCtx.measureText(props.domain).width;

  const totalHeight = computeLayoutHeight(hasOgImage, ogH, titleLines, descLines);

  const layout: BookmarkLayout = {
    titleLines,
    descLines,
    totalHeight,
    hasOgImage,
    ogDisplayH: ogH,
    domainTextWidth,
  };
  layoutCache.set(id, layout);
  return layout;
}

function computeLayoutHeight(hasOgImage: boolean, ogH: number, titleLines: string[], descLines: string[]): number {
  const titleH = titleLines.length * TITLE_LINE_H;
  const descH = descLines.length * DESC_LINE_H;
  const domainLineH = FAVICON_SIZE;

  if (hasOgImage) {
    return ogH + CARD_PADDING + titleH + descH + domainLineH + CARD_PADDING;
  }
  if (titleLines.length > 0) {
    return CARD_PADDING + titleH + descH + domainLineH + CARD_PADDING;
  }
  // Defensive minimum
  return CARD_PADDING + domainLineH + CARD_PADDING;
}

/** Returns card height based on bookmark metadata. Works with partial unfurl data (no id/cache). */
export function computeBookmarkHeight(data: {
  title?: string;
  description?: string;
  ogImageAssetId?: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
}): number {
  const hasOgImage = !!data.ogImageAssetId;
  const ogH = hasOgImage ? ogDisplayHeight(data.ogImageWidth ?? 0, data.ogImageHeight ?? 0, BOOKMARK_WIDTH) : 0;
  const textWidth = BOOKMARK_WIDTH - CARD_PADDING * 2;

  measureCtx.font = `bold ${TITLE_FONT_SIZE}px Inter, sans-serif`;
  const titleLines = wrapText(measureCtx, data.title ?? '', textWidth, TITLE_MAX_LINES);

  measureCtx.font = `${DESC_FONT_SIZE}px Inter, sans-serif`;
  const descLines = wrapText(measureCtx, data.description ?? '', textWidth, DESC_MAX_LINES);

  return computeLayoutHeight(hasOgImage, ogH, titleLines, descLines);
}

// ---------------------------------------------------------------------------
// BBox + Frame computation
// ---------------------------------------------------------------------------

export function getBookmarkShadowPad(scale: number): number {
  return BOOKMARK_WIDTH * scale * 0.15;
}

/**
 * Compute bbox for a bookmark from its props.
 * Populates both layout cache and frame cache as side effects.
 */
export function computeBookmarkBBox(id: string, props: BookmarkProps): BBoxTuple {
  getLayout(id, props); // Populate layout cache
  const s = props.scale;
  const w = BOOKMARK_WIDTH * s;
  const h = props.height * s;
  const frame: FrameTuple = [props.origin[0], props.origin[1], w, h];
  bookmarkFrameCache.set(id, frame);
  const sp = getBookmarkShadowPad(s);
  return [frame[0] - sp, frame[1] - sp, frame[0] + w + sp, frame[1] + h + sp];
}

/** Read cached frame for a bookmark. Populated by computeBookmarkBBox. */
export function getBookmarkFrame(id: string): FrameTuple | null {
  return bookmarkFrameCache.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

export const bookmarkCache = {
  /** Remove layout for a single bookmark (deletion or invalidation) */
  evict(id: string) {
    layoutCache.delete(id);
    bookmarkFrameCache.delete(id);
  },
  /** Clear all bookmark layouts (room teardown) */
  clear() {
    layoutCache.clear();
    bookmarkFrameCache.clear();
  },
};

/** @deprecated Use bookmarkCache.evict(id) */
export function invalidateBookmarkLayout(id: string): void {
  layoutCache.delete(id);
}

/** @deprecated Use bookmarkCache.clear() */
export function clearBookmarkLayouts(): void {
  layoutCache.clear();
}

// ---------------------------------------------------------------------------
// Open-link icon (external arrow, ~10x10wu)
// ---------------------------------------------------------------------------

const boxArrowPath = new Path2D('M1 11H11V7.5 M1 11V1H4.5 M5 7L11 1 M7.5 1H11V4');

// ---------------------------------------------------------------------------
// "Open" button drawing
// ---------------------------------------------------------------------------

function drawOpenButton(ctx: CanvasRenderingContext2D, bx: number, by: number, hovered = false): void {
  // Background rounded rect — white pill with border
  ctx.fillStyle = hovered ? '#e8e8e8' : '#FFFFFF';
  ctx.beginPath();
  ctx.roundRect(bx, by, OPEN_BTN_W, OPEN_BTN_H, OPEN_BTN_RADIUS);
  ctx.fill();
  ctx.strokeStyle = '#d1d5db';
  ctx.lineWidth = 1;
  ctx.stroke();

  // "Open" text on left
  ctx.font = '600 13px Inter, sans-serif';
  ctx.fillStyle = '#374151';
  ctx.textBaseline = 'middle';
  ctx.fillText('Open', bx + 11, by + OPEN_BTN_H / 2);

  // Box-arrow icon on right
  const iconSize = 12;
  const iconX = bx + OPEN_BTN_W - iconSize - 10;
  const iconY = by + (OPEN_BTN_H - iconSize) / 2;
  ctx.save();
  ctx.translate(iconX, iconY);
  ctx.strokeStyle = '#374151';
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(boxArrowPath);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Draw bookmark — three data-driven layouts
// ---------------------------------------------------------------------------

export function drawBookmark(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const props = getBookmarkProps(handle.y);
  if (!props) {
    console.error('Bookmark props are null');
    return;
  }

  const layout = getLayout(handle.id, props);
  const s = props.scale;

  ctx.save();
  ctx.translate(props.origin[0], props.origin[1]);
  ctx.scale(s, s);

  // 1. Shadow + body at local origin
  renderNoteBody(ctx, 0, 0, BOOKMARK_WIDTH, props.height, CARD_FILL);

  // --- Full card (has OG image) ---
  if (layout.hasOgImage) {
    drawFullCard(ctx, 0, 0, BOOKMARK_WIDTH, layout, props);
  } else if (layout.titleLines.length > 0) {
    // --- Text card (has title, no OG image) ---
    drawTextCard(ctx, 0, 0, BOOKMARK_WIDTH, layout, props);
  }

  ctx.restore();
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
    drawOpenButton(ctx, x + w - OPEN_BTN_W - OPEN_BTN_MARGIN, y + displayH - OPEN_BTN_H - OPEN_BTN_MARGIN);

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
// Shared drawing helpers
// ---------------------------------------------------------------------------

function drawTitleLines(ctx: CanvasRenderingContext2D, x: number, y: number, lines: string[]): void {
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
  buttonHovered = false,
  domainHovered = false,
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
  ctx.fillStyle = domainHovered ? '#2563eb' : '#6b7280';
  ctx.textBaseline = 'middle';
  ctx.fillText(props.domain, iconX, domainY + FAVICON_SIZE / 2);

  // "Open" button on the right (when no OG image)
  if (showOpenButton) {
    drawOpenButton(ctx, textX + textWidth - OPEN_BTN_W, domainY + (FAVICON_SIZE - OPEN_BTN_H) / 2, buttonHovered);
  }
}

// ---------------------------------------------------------------------------
// Public layout accessor (for external hit testing)
// ---------------------------------------------------------------------------

export function getBookmarkLayout(id: string, props: NonNullable<ReturnType<typeof getBookmarkProps>>, cardWidth?: number): BookmarkLayout {
  return getLayout(id, props, cardWidth);
}

// ---------------------------------------------------------------------------
// Frame-local hit-test bounds
// ---------------------------------------------------------------------------

/**
 * Returns the Open button rect in frame-local coordinates.
 * Full card: overlaid on OG image bottom-right. Text card: right-aligned in domain row.
 */
export function getOpenButtonLocalBounds(layout: BookmarkLayout, cardWidth: number): LocalRect {
  if (layout.hasOgImage) {
    return {
      lx: cardWidth - OPEN_BTN_W - OPEN_BTN_MARGIN,
      ly: layout.ogDisplayH - OPEN_BTN_H - OPEN_BTN_MARGIN,
      lw: OPEN_BTN_W,
      lh: OPEN_BTN_H,
    };
  }
  // Text card: button in bottom row
  const titleH = layout.titleLines.length * TITLE_LINE_H;
  const descH = layout.descLines.length * DESC_LINE_H;
  const domainY = CARD_PADDING + titleH + descH + 4;
  return {
    lx: cardWidth - CARD_PADDING - OPEN_BTN_W,
    ly: domainY + (FAVICON_SIZE - OPEN_BTN_H) / 2,
    lw: OPEN_BTN_W,
    lh: OPEN_BTN_H,
  };
}

/**
 * Returns the domain text rect in frame-local coordinates.
 * Uses cached domainTextWidth from layout — no re-measurement.
 */
export function getDomainLinkLocalBounds(layout: BookmarkLayout, _cardWidth: number, hasFavicon: boolean): LocalRect {
  const titleH = layout.titleLines.length * TITLE_LINE_H;
  const descH = layout.descLines.length * DESC_LINE_H;
  const domainY = layout.hasOgImage ? layout.ogDisplayH + CARD_PADDING + titleH + descH + 4 : CARD_PADDING + titleH + descH + 4;
  const faviconOffset = hasFavicon ? FAVICON_SIZE + 6 : 0;
  return {
    lx: CARD_PADDING + faviconOffset,
    ly: domainY,
    lw: layout.domainTextWidth,
    lh: FAVICON_SIZE,
  };
}
