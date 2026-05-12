import { prettifyDomain } from '@avlo/shared';
import { getHandle } from '@/runtime/room-runtime';
import { getBookmarkProps } from '../accessors';
import { getBitmap } from '../image/image-manager';
import {
  getNoteCornerRadius,
  NOTE_SHADOW_BOTTOM_RATIO,
  NOTE_SHADOW_SIDE_RATIO,
  NOTE_SHADOW_TOP_RATIO,
  renderNoteBody,
} from '../text/sticky-note';
import { buildFontString, measureTextCached } from '../text/text-system';
import type { BBoxTuple, FrameTuple } from '../types/geometry';
import type { BookmarkProps, ObjectHandle } from '../types/objects';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BOOKMARK_WIDTH = 300;
const CARD_PADDING = 14;
const SECTION_GAP = 6;
const MIN_OG_H = 70;
const MAX_OG_H = 250;
const TITLE_FONT_SIZE = 14;
const DESC_FONT_SIZE = 12;
const DISPLAY_FONT_SIZE = 13;
const TITLE_LINE_H = 19;
const DESC_LINE_H = 16;
const TITLE_MAX_LINES = 2;
const DESC_MAX_LINES = 3;
const FAVICON_SIZE = 18;
const FAVICON_GAP = 6;
const CARD_FILL = '#FFFFFF';
const CARD_RADIUS = getNoteCornerRadius(BOOKMARK_WIDTH);
const OPEN_BTN_W = 78;
const OPEN_BTN_H = 28;
const OPEN_BTN_RADIUS = 6;
const OPEN_BTN_MARGIN = 10;

const TITLE_COLOR = '#1a1a1a';
const DESC_COLOR = '#6b7280';
const DISPLAY_COLOR = '#1a1a1a';
const OG_PLACEHOLDER_FILL = '#f5f5f5';
const OPEN_BTN_FILL = '#FFFFFF';
const OPEN_BTN_FILL_HOVER = '#e8e8e8';
const OPEN_BTN_BORDER = '#d1d5db';
const OPEN_BTN_INK = '#374151';

const ELLIPSIS = '…';

// Font strings — pre-computed once so every layout/render reuses the same
// canonical key into text-system's measureTextCached cache, and we avoid
// per-call template-literal allocation.
const TITLE_FONT = buildFontString(true, false, TITLE_FONT_SIZE, 'Inter');
const DESC_FONT = buildFontString(false, false, DESC_FONT_SIZE, 'Inter');
const DISPLAY_FONT = buildFontString(false, false, DISPLAY_FONT_SIZE, 'Inter');
const OPEN_BTN_FONT = '600 13px Inter, sans-serif'; // 600 isn't in our normal/bold matrix

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalRect {
  lx: number;
  ly: number;
  lw: number;
  lh: number;
}

interface BookmarkLayout {
  titleLines: string[];
  descLines: string[];
  totalHeight: number;
  hasOgImage: boolean;
  ogDisplayH: number;
  displayDomain: string;
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const layoutCache = new Map<string, BookmarkLayout>();
const bookmarkFrameCache = new Map<string, FrameTuple>();

export const bookmarkCache = {
  evict(id: string) {
    layoutCache.delete(id);
    bookmarkFrameCache.delete(id);
  },
  clear() {
    layoutCache.clear();
    bookmarkFrameCache.clear();
  },
};

// ---------------------------------------------------------------------------
// Text wrapping — robust against oversized single words, allocation-lean
// ---------------------------------------------------------------------------

function wrapText(text: string, maxWidth: number, maxLines: number, font: string): string[] {
  if (!text) return [];
  const stripped = text.trim();
  if (!stripped) return [];
  const words = stripped.split(/\s+/);
  const spaceW = measureTextCached(font, ' ');

  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi];
    if (!word) continue;
    const wordW = measureTextCached(font, word);
    const glueW = current ? spaceW : 0;

    if (currentWidth + glueW + wordW <= maxWidth) {
      current = current ? current + ' ' + word : word;
      currentWidth += glueW + wordW;
      continue;
    }

    // Word doesn't fit on the current line. If committing would exceed
    // maxLines, splice all remaining text into one truncated final line.
    if (lines.length + 1 >= maxLines) {
      let overflow = current ? current + ' ' + word : word;
      for (let j = wi + 1; j < words.length; j++) overflow += ' ' + words[j];
      lines.push(truncateWithEllipsis(overflow, font, maxWidth));
      return lines;
    }

    if (current) {
      lines.push(current);
      current = '';
      currentWidth = 0;
    }

    if (wordW <= maxWidth) {
      current = word;
      currentWidth = wordW;
      continue;
    }

    // Single word wider than the card — character-break across lines until
    // it fits or we hit maxLines.
    let remaining = word;
    while (remaining) {
      const fitLen = findFittingPrefix(remaining, font, maxWidth);
      if (fitLen === 0) {
        // Pathological: a single char doesn't fit. Render as-is and stop.
        lines.push(remaining);
        return lines;
      }
      if (fitLen >= remaining.length) {
        current = remaining;
        currentWidth = measureTextCached(font, remaining);
        break;
      }
      if (lines.length + 1 >= maxLines) {
        let rest = remaining;
        for (let j = wi + 1; j < words.length; j++) rest += ' ' + words[j];
        lines.push(truncateWithEllipsis(rest, font, maxWidth));
        return lines;
      }
      lines.push(remaining.slice(0, fitLen));
      remaining = remaining.slice(fitLen);
    }
  }

  if (current) lines.push(current);
  return lines;
}

function findFittingPrefix(text: string, font: string, maxWidth: number): number {
  if (measureTextCached(font, text) <= maxWidth) return text.length;
  if (measureTextCached(font, text.charAt(0)) > maxWidth) return 0;
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureTextCached(font, text.slice(0, mid)) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  // Don't slice in the middle of a surrogate pair.
  if (lo > 0 && lo < text.length) {
    const c = text.charCodeAt(lo - 1);
    if (c >= 0xd800 && c <= 0xdbff) lo -= 1;
  }
  return lo;
}

function truncateWithEllipsis(text: string, font: string, maxWidth: number): string {
  if (measureTextCached(font, text) <= maxWidth) return text;
  const ellW = measureTextCached(font, ELLIPSIS);
  if (ellW > maxWidth) return ELLIPSIS;
  const budget = maxWidth - ellW;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureTextCached(font, text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0 && lo < text.length) {
    const c = text.charCodeAt(lo - 1);
    if (c >= 0xd800 && c <= 0xdbff) lo -= 1;
  }
  return text.slice(0, lo) + ELLIPSIS;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function ogDisplayHeight(ogW: number, ogH: number): number {
  if (ogW <= 0 || ogH <= 0) return MIN_OG_H;
  const natural = BOOKMARK_WIDTH * (ogH / ogW);
  return Math.min(Math.max(natural, MIN_OG_H), MAX_OG_H);
}

interface LayoutInput {
  title?: string;
  description?: string;
  domain?: string;
  ogImageAssetId?: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
}

function buildLayout(data: LayoutInput): BookmarkLayout {
  const hasOgImage = !!data.ogImageAssetId;
  const ogDisplayH = hasOgImage ? ogDisplayHeight(data.ogImageWidth ?? 0, data.ogImageHeight ?? 0) : 0;
  const textWidth = BOOKMARK_WIDTH - CARD_PADDING * 2;
  const titleLines = wrapText(data.title ?? '', textWidth, TITLE_MAX_LINES, TITLE_FONT);
  const descLines = wrapText(data.description ?? '', textWidth, DESC_MAX_LINES, DESC_FONT);
  const displayDomain = prettifyDomain(data.domain ?? '');
  const totalHeight = computeLayoutHeight(hasOgImage, ogDisplayH, titleLines.length, descLines.length);
  return { titleLines, descLines, totalHeight, hasOgImage, ogDisplayH, displayDomain };
}

function computeLayoutHeight(hasOgImage: boolean, ogH: number, titleLineCount: number, descLineCount: number): number {
  const titleH = titleLineCount * TITLE_LINE_H;
  const descH = descLineCount * DESC_LINE_H;
  const titleToDesc = titleLineCount && descLineCount ? SECTION_GAP : 0;
  const textToDomain = titleLineCount || descLineCount ? SECTION_GAP : 0;

  if (hasOgImage) {
    return ogH + CARD_PADDING + titleH + titleToDesc + descH + textToDomain + FAVICON_SIZE + CARD_PADDING;
  }
  if (titleLineCount > 0) {
    return CARD_PADDING + titleH + titleToDesc + descH + textToDomain + FAVICON_SIZE + CARD_PADDING;
  }
  return CARD_PADDING + FAVICON_SIZE + CARD_PADDING;
}

function getLayout(id: string, props: BookmarkProps): BookmarkLayout {
  const cached = layoutCache.get(id);
  if (cached) return cached;
  const layout = buildLayout(props);
  layoutCache.set(id, layout);
  return layout;
}

/** Returns card height based on bookmark metadata. Works with partial unfurl data (no id/cache). */
export function computeBookmarkHeight(data: LayoutInput): number {
  return buildLayout(data).totalHeight;
}

// ---------------------------------------------------------------------------
// BBox + Frame
// ---------------------------------------------------------------------------

/**
 * Compute bbox for a bookmark from its props. Populates layout + frame caches
 * as a side effect; subsequent `getBookmarkFrame(id)` reads from the frame cache.
 * Bbox is asymmetric — shadow extends mostly downward, so top/sides need only a
 * thin halo while the bottom holds the long downward tail (single source of
 * truth: NOTE_SHADOW_*_RATIO constants from sticky-note).
 */
export function computeBookmarkBBox(id: string, props: BookmarkProps): BBoxTuple {
  getLayout(id, props);
  const s = props.scale;
  const w = BOOKMARK_WIDTH * s;
  const h = props.height * s;
  const frame: FrameTuple = [props.origin[0], props.origin[1], w, h];
  bookmarkFrameCache.set(id, frame);
  const padTop = w * NOTE_SHADOW_TOP_RATIO;
  const padSide = w * NOTE_SHADOW_SIDE_RATIO;
  const padBottom = w * NOTE_SHADOW_BOTTOM_RATIO;
  return [frame[0] - padSide, frame[1] - padTop, frame[0] + w + padSide, frame[1] + h + padBottom];
}

export function getBookmarkFrame(id: string): FrameTuple | null {
  return bookmarkFrameCache.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// "Open" button — drawBookmark paints hover xor non-hover in a single pass on
// the base canvas. objects.ts threads `handle.id === _hoveredOpenBookmarkId`
// per visible candidate, so Z-order works naturally (base-canvas occluders
// stay on top of the button when they should).
// ---------------------------------------------------------------------------

const boxArrowPath = new Path2D('M1 11H11V7.5 M1 11V1H4.5 M5 7L11 1 M7.5 1H11V4');

function drawOpenButton(ctx: CanvasRenderingContext2D, bx: number, by: number, hovered = false): void {
  ctx.fillStyle = hovered ? OPEN_BTN_FILL_HOVER : OPEN_BTN_FILL;
  ctx.beginPath();
  ctx.roundRect(bx, by, OPEN_BTN_W, OPEN_BTN_H, OPEN_BTN_RADIUS);
  ctx.fill();
  ctx.strokeStyle = OPEN_BTN_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = OPEN_BTN_FONT;
  ctx.fillStyle = OPEN_BTN_INK;
  ctx.textBaseline = 'middle';
  ctx.fillText('Open', bx + 11, by + OPEN_BTN_H / 2);

  const iconSize = 12;
  const iconX = bx + OPEN_BTN_W - iconSize - 10;
  const iconY = by + (OPEN_BTN_H - iconSize) / 2;
  ctx.save();
  ctx.translate(iconX, iconY);
  ctx.strokeStyle = OPEN_BTN_INK;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(boxArrowPath);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// drawBookmark — two data-driven layouts (full / text)
// ---------------------------------------------------------------------------

export function drawBookmark(ctx: CanvasRenderingContext2D, handle: ObjectHandle, hoveredOpen: boolean): void {
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

  renderNoteBody(ctx, 0, 0, BOOKMARK_WIDTH, props.height, CARD_FILL);

  if (layout.hasOgImage) {
    drawFullCard(ctx, BOOKMARK_WIDTH, layout, props, hoveredOpen);
  } else if (layout.titleLines.length > 0) {
    drawTextCard(ctx, BOOKMARK_WIDTH, layout, props, hoveredOpen);
  }

  ctx.restore();
}

function drawFullCard(ctx: CanvasRenderingContext2D, w: number, layout: BookmarkLayout, props: BookmarkProps, hoveredOpen: boolean): void {
  const displayH = layout.ogDisplayH;

  // OG image (top, with rounded top corners)
  if (props.ogImageAssetId) {
    const bitmap = getBitmap(props.ogImageAssetId);
    if (bitmap) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(0, 0, w, displayH, [CARD_RADIUS, CARD_RADIUS, 0, 0]);
      ctx.clip();

      const naturalH = w * (bitmap.height / bitmap.width);
      if (naturalH > displayH) {
        const drawScale = w / bitmap.width;
        const srcH = displayH / drawScale;
        const srcY = (bitmap.height - srcH) / 2;
        ctx.drawImage(bitmap, 0, srcY, bitmap.width, srcH, 0, 0, w, displayH);
      } else {
        ctx.drawImage(bitmap, 0, 0, w, displayH);
      }
      ctx.restore();
    } else {
      ctx.fillStyle = OG_PLACEHOLDER_FILL;
      ctx.beginPath();
      ctx.roundRect(0, 0, w, displayH, [CARD_RADIUS, CARD_RADIUS, 0, 0]);
      ctx.fill();
    }
    drawOpenButton(ctx, w - OPEN_BTN_W - OPEN_BTN_MARGIN, displayH - OPEN_BTN_H - OPEN_BTN_MARGIN, hoveredOpen);
  }

  const textX = CARD_PADDING;
  const textWidth = w - CARD_PADDING * 2;
  let cursorY = displayH + CARD_PADDING;

  cursorY = drawTitleLines(ctx, textX, cursorY, layout.titleLines);
  if (layout.titleLines.length && layout.descLines.length) cursorY += SECTION_GAP;
  cursorY = drawDescLines(ctx, textX, cursorY, layout.descLines);
  if (layout.titleLines.length || layout.descLines.length) cursorY += SECTION_GAP;

  // Bottom row: favicon + display name (Open button is on the image — don't double-draw)
  drawBottomRow(ctx, textX, cursorY, textWidth, layout, props.faviconAssetId, false, hoveredOpen);
}

function drawTextCard(ctx: CanvasRenderingContext2D, w: number, layout: BookmarkLayout, props: BookmarkProps, hoveredOpen: boolean): void {
  const textX = CARD_PADDING;
  const textWidth = w - CARD_PADDING * 2;
  let cursorY = CARD_PADDING;

  cursorY = drawTitleLines(ctx, textX, cursorY, layout.titleLines);
  if (layout.titleLines.length && layout.descLines.length) cursorY += SECTION_GAP;
  cursorY = drawDescLines(ctx, textX, cursorY, layout.descLines);
  if (layout.titleLines.length || layout.descLines.length) cursorY += SECTION_GAP;

  drawBottomRow(ctx, textX, cursorY, textWidth, layout, props.faviconAssetId, true, hoveredOpen);
}

function drawTitleLines(ctx: CanvasRenderingContext2D, x: number, y: number, lines: string[]): number {
  if (lines.length === 0) return y;
  ctx.font = TITLE_FONT;
  ctx.fillStyle = TITLE_COLOR;
  ctx.textBaseline = 'top';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x, y);
    y += TITLE_LINE_H;
  }
  return y;
}

function drawDescLines(ctx: CanvasRenderingContext2D, x: number, y: number, lines: string[]): number {
  if (lines.length === 0) return y;
  ctx.font = DESC_FONT;
  ctx.fillStyle = DESC_COLOR;
  ctx.textBaseline = 'top';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x, y);
    y += DESC_LINE_H;
  }
  return y;
}

function drawBottomRow(
  ctx: CanvasRenderingContext2D,
  textX: number,
  rowY: number,
  rowWidth: number,
  layout: BookmarkLayout,
  faviconAssetId: string | undefined,
  showOpenButton: boolean,
  hoveredOpen: boolean,
): void {
  let iconX = textX;
  if (faviconAssetId) {
    const favicon = getBitmap(faviconAssetId);
    if (favicon) {
      ctx.drawImage(favicon, iconX, rowY, FAVICON_SIZE, FAVICON_SIZE);
      iconX += FAVICON_SIZE + FAVICON_GAP;
    }
  }

  ctx.font = DISPLAY_FONT;
  ctx.fillStyle = DISPLAY_COLOR;
  ctx.textBaseline = 'middle';
  ctx.fillText(layout.displayDomain, iconX, rowY + FAVICON_SIZE / 2);

  if (showOpenButton) {
    drawOpenButton(ctx, textX + rowWidth - OPEN_BTN_W, rowY + (FAVICON_SIZE - OPEN_BTN_H) / 2, hoveredOpen);
  }
}

// ---------------------------------------------------------------------------
// Frame-local hit-test bounds — single module scratch, mutated per call.
// ---------------------------------------------------------------------------

/**
 * MUTABLE scratch — `getOpenButtonLocalBounds` returns this same object every
 * call. If you need to call it twice before consuming the first result, copy
 * the fields you need. Mirrors the marqueeBBox/marqueeCurrent idiom in
 * SelectTool.ts (lines 73-74). `lw`/`lh` are set once at module init (always
 * OPEN_BTN_W/OPEN_BTN_H in local space); only `lx`/`ly` mutate.
 */
const _openBtnScratch: LocalRect = { lx: 0, ly: 0, lw: OPEN_BTN_W, lh: OPEN_BTN_H };

/**
 * MUTABLE scratch — `getOpenButtonWorldBBox` returns this same tuple every
 * call. RenderLoop.invalidateWorldBBox consumes synchronously (reads slots
 * [0..3], writes derived values into its own buffer), so back-to-back calls
 * for a cross-transition (`prev → invalidate → next → invalidate`) are safe.
 */
const _openBtnWorldBBox: BBoxTuple = [0, 0, 0, 0];

/**
 * Returns the Open button rect in frame-local coordinates (card is always
 * BOOKMARK_WIDTH = 300 in local space; scale is applied at the draw-transform
 * level, not at this layer). MUTATES `_openBtnScratch` — see scratch comment.
 * Full card: overlaid on OG image bottom-right. Text card: right-aligned in the favicon row.
 */
export function getOpenButtonLocalBounds(layout: BookmarkLayout): LocalRect {
  if (layout.hasOgImage) {
    _openBtnScratch.lx = BOOKMARK_WIDTH - OPEN_BTN_W - OPEN_BTN_MARGIN;
    _openBtnScratch.ly = layout.ogDisplayH - OPEN_BTN_H - OPEN_BTN_MARGIN;
    return _openBtnScratch;
  }
  const titleH = layout.titleLines.length * TITLE_LINE_H;
  const descH = layout.descLines.length * DESC_LINE_H;
  const titleToDesc = layout.titleLines.length && layout.descLines.length ? SECTION_GAP : 0;
  const textToDomain = layout.titleLines.length || layout.descLines.length ? SECTION_GAP : 0;
  const rowY = CARD_PADDING + titleH + titleToDesc + descH + textToDomain;
  _openBtnScratch.lx = BOOKMARK_WIDTH - CARD_PADDING - OPEN_BTN_W;
  _openBtnScratch.ly = rowY + (FAVICON_SIZE - OPEN_BTN_H) / 2;
  return _openBtnScratch;
}

/**
 * Test whether a world-space point falls inside the Open button's visible rect.
 * Caller responsible for visibility/occlusion (SelectTool gates this on
 * `pickTopmostPaint` first). Consumes `_openBtnScratch` synchronously — no
 * re-call within this function.
 */
export function hitTestOpenButton(handle: ObjectHandle, worldX: number, worldY: number): boolean {
  if (handle.kind !== 'bookmark') return false;
  const props = getBookmarkProps(handle.y);
  if (!props) return false;
  const layout = layoutCache.get(handle.id);
  const frame = bookmarkFrameCache.get(handle.id);
  if (!layout || !frame) return false;
  const localX = (worldX - frame[0]) / props.scale;
  const localY = (worldY - frame[1]) / props.scale;
  const r = getOpenButtonLocalBounds(layout);
  return localX >= r.lx && localX <= r.lx + r.lw && localY >= r.ly && localY <= r.ly + r.lh;
}

/**
 * World-space bbox of the Open button rect, padded for the 1px stroke at the
 * current scale. `AA_MARGIN` is added inside `invalidateWorldBBox` (device
 * pixels), so callers only pay world-space stroke pad here. Returns `null`
 * when handle/props/layout/frame caches are missing (pre-first-render or
 * post-deletion) — caller bails the invalidate. MUTATES `_openBtnWorldBBox`;
 * see scratch comment.
 */
export function getOpenButtonWorldBBox(id: string): BBoxTuple | null {
  const handle = getHandle(id);
  if (!handle || handle.kind !== 'bookmark') return null;
  const props = getBookmarkProps(handle.y);
  if (!props) return null;
  const layout = layoutCache.get(id);
  const frame = bookmarkFrameCache.get(id);
  if (!layout || !frame) return null;
  const r = getOpenButtonLocalBounds(layout);
  const s = props.scale;
  const pad = 0.5 * s; // 1px lineWidth in pre-scale → 0.5*s world per side
  _openBtnWorldBBox[0] = frame[0] + r.lx * s - pad;
  _openBtnWorldBBox[1] = frame[1] + r.ly * s - pad;
  _openBtnWorldBBox[2] = frame[0] + (r.lx + r.lw) * s + pad;
  _openBtnWorldBBox[3] = frame[1] + (r.ly + r.lh) * s + pad;
  return _openBtnWorldBBox;
}
