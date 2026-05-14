import { prettifyDomain } from '@avlo/shared';
import { readBookmarkRender } from '@/renderer/render-accessors';
import { getHandle } from '@/runtime/room-runtime';
import { getBookmarkProps } from '../accessors';
import { getBitmap } from '../image/image-manager';
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
// Fixed corner radius, independent of card height. Capped at 12wu so the 3-slice
// shadow cache supports the realistic bookmark min height (~71wu); see shadow
// section below.
const BOOKMARK_CORNER_RADIUS = 10;
const CARD_RADIUS = BOOKMARK_CORNER_RADIUS;
const OPEN_BTN_W = 78;
const OPEN_BTN_H = 28;
const OPEN_BTN_RADIUS = 6;
const OPEN_BTN_MARGIN = 10;

// Asymmetric shadow pad ratios — bookmark-local (was shared with notes; now
// each kind owns its own cache and pads). Exported so the bbox fallback in
// `geometry/bbox.ts` reads from a single source of truth.
export const BOOKMARK_SHADOW_TOP_RATIO = 0.06;
export const BOOKMARK_SHADOW_SIDE_RATIO = 0.075;
export const BOOKMARK_SHADOW_BOTTOM_RATIO = 0.12;

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
// Shadow system — vertical 3-slice cache (single canvas, ALL bookmarks)
// ---------------------------------------------------------------------------
//
// Width is constant (BOOKMARK_WIDTH = 300) and corner radius is constant
// (BOOKMARK_CORNER_RADIUS). Height varies. The shadow's horizontal cross-section
// is therefore identical at every height; only the vertical side strips need
// to stretch with the body. After R + 1.5·blur (~28wu) of distance from either
// horizontal body edge, the shadow becomes fully translation-invariant in y —
// every row down the side is pixel-identical.
//
// Bake once: top cap (corner + tail + 1 invariant row) + 2 invariant rows +
// bottom cap (corner + tail + 1 invariant row). Draw three drawImage calls per
// bookmark: top cap → middle (stretched vertically) → bottom cap. No horizontal
// stretching (BAKE_W → BAKE_W is 1:1 in world units), so the rounded corner
// curves in the cache land on the exact destination pixels of the body's curve
// — no curve mismatch, no AA fringe.
//
// Seam invariant: cap's last source row is the FIRST invariant body row, and
// the middle samples invariant rows after that. Since invariant rows are
// pixel-identical, the cap → middle and middle → cap transitions are exact
// continuations — no visible seam regardless of how `midDestH` stretches.
//
// Memory: one OffscreenCanvas (~210K device pixels at DPR=2 ≈ 0.85 MB),
// independent of how many bookmarks are on screen.

const BOOKMARK_SHADOW_DROP_BLUR_RATIO = 0.04;
const BOOKMARK_SHADOW_DROP_OFFSET_RATIO = 0.045;
const BOOKMARK_SHADOW_DROP_COLOR = 'rgba(0,0,0,0.11)';
const BOOKMARK_SHADOW_CONTACT_BLUR_RATIO = 0.013;
const BOOKMARK_SHADOW_CONTACT_OFFSET_RATIO = 0.008;
const BOOKMARK_SHADOW_CONTACT_COLOR = 'rgba(0,0,0,0.07)';

const SHADOW_PAD_TOP = BOOKMARK_WIDTH * BOOKMARK_SHADOW_TOP_RATIO; //         18
const SHADOW_PAD_SIDE = BOOKMARK_WIDTH * BOOKMARK_SHADOW_SIDE_RATIO; //       22.5
const SHADOW_PAD_BOTTOM = BOOKMARK_WIDTH * BOOKMARK_SHADOW_BOTTOM_RATIO; //   36
const SHADOW_DROP_BLUR = BOOKMARK_WIDTH * BOOKMARK_SHADOW_DROP_BLUR_RATIO; // 12
const SHADOW_GAUSSIAN_TAIL = SHADOW_DROP_BLUR * 1.5; //                       18 (drop dominates contact's 5.85)

// +1 on each cap height places the last cap source row in the invariant zone,
// making the cap → middle seam pixel-identical (vs 1 row of residual corner
// influence without the +1). Bake body has 2 extra rows so MID_BAKE_H = 2
// invariant rows sit comfortably between caps.
const SHADOW_CAP_TOP_H = SHADOW_PAD_TOP + BOOKMARK_CORNER_RADIUS + SHADOW_GAUSSIAN_TAIL + 1; //  47
const SHADOW_CAP_BOT_H = SHADOW_PAD_BOTTOM + BOOKMARK_CORNER_RADIUS + SHADOW_GAUSSIAN_TAIL + 1; // 65
const SHADOW_MID_BAKE_H = 2;
const SHADOW_BAKE_BODY_H = 2 * (BOOKMARK_CORNER_RADIUS + SHADOW_GAUSSIAN_TAIL) + SHADOW_MID_BAKE_H + 2; // 60
const SHADOW_BAKE_W = BOOKMARK_WIDTH + 2 * SHADOW_PAD_SIDE; //                                       345
const SHADOW_BAKE_H = SHADOW_PAD_TOP + SHADOW_BAKE_BODY_H + SHADOW_PAD_BOTTOM; //                    114
// Minimum body height for clean 3-slice. Below this, `midDestH` clamps to 0
// and caps render back-to-back; bbox compensates so dirty rects stay valid.
// Realistic bookmark min ≈ 71 (text-only with 1 title line), so this is 13wu
// of headroom against the practical floor.
const SHADOW_H_MIN_SUPPORTED = 2 * (BOOKMARK_CORNER_RADIUS + SHADOW_GAUSSIAN_TAIL + 1); //          58

let _bookmarkShadow: OffscreenCanvas | null = null;
let _bookmarkShadowDpr = 0;

function ensureBookmarkShadow(dpr: number): OffscreenCanvas {
  if (_bookmarkShadow && _bookmarkShadowDpr === dpr) return _bookmarkShadow;

  const canvas = new OffscreenCanvas(Math.ceil(SHADOW_BAKE_W * dpr), Math.ceil(SHADOW_BAKE_H * dpr));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#000';

  // Single body path — used for both shadow casters AND the punch. The
  // destination body fill in `renderBookmarkBody` uses the SAME radius
  // (BOOKMARK_CORNER_RADIUS), so the cache's punched silhouette and the
  // destination body silhouette coincide pixel-perfectly.
  ctx.beginPath();
  ctx.roundRect(SHADOW_PAD_SIDE, SHADOW_PAD_TOP, BOOKMARK_WIDTH, SHADOW_BAKE_BODY_H, BOOKMARK_CORNER_RADIUS);

  // Drop — the long downward tail.
  ctx.shadowColor = BOOKMARK_SHADOW_DROP_COLOR;
  ctx.shadowBlur = SHADOW_DROP_BLUR;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = BOOKMARK_WIDTH * BOOKMARK_SHADOW_DROP_OFFSET_RATIO;
  ctx.fill();

  // Contact — tight halo anchored at the body edge.
  ctx.shadowColor = BOOKMARK_SHADOW_CONTACT_COLOR;
  ctx.shadowBlur = BOOKMARK_WIDTH * BOOKMARK_SHADOW_CONTACT_BLUR_RATIO;
  ctx.shadowOffsetY = BOOKMARK_WIDTH * BOOKMARK_SHADOW_CONTACT_OFFSET_RATIO;
  ctx.fill();

  // Punch — same path, no expansion. Removes every opaque fill pixel; only the
  // gaussian halo around the body silhouette survives.
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  _bookmarkShadow = canvas;
  _bookmarkShadowDpr = dpr;
  return canvas;
}

function drawBookmarkShadow(ctx: CanvasRenderingContext2D, x: number, y: number, h: number): void {
  const dpr = window.devicePixelRatio || 1;
  const cache = ensureBookmarkShadow(dpr);

  // For h ≥ SHADOW_H_MIN_SUPPORTED: midDestH = h - SHADOW_H_MIN_SUPPORTED ≥ 0,
  // total drawn height = h + padTop + padBottom exactly. Bbox covers it.
  // For h < SHADOW_H_MIN_SUPPORTED (unreachable in practice): midDestH = 0,
  // caps render back-to-back, total drawn height = SHADOW_H_MIN_SUPPORTED +
  // padTop + padBottom. `computeBookmarkBBox` clamps to match.
  const midDestH = h > SHADOW_H_MIN_SUPPORTED ? h - SHADOW_H_MIN_SUPPORTED : 0;

  const dx = x - SHADOW_PAD_SIDE;
  const dy = y - SHADOW_PAD_TOP;
  const srcW = SHADOW_BAKE_W * dpr;

  // Top cap — no stretching (BAKE_W → BAKE_W is 1:1 in world units; cache
  // contains the rounded top corners and gaussian decay below them).
  ctx.drawImage(cache, 0, 0, srcW, SHADOW_CAP_TOP_H * dpr, dx, dy, SHADOW_BAKE_W, SHADOW_CAP_TOP_H);

  // Middle — vertical stretch only. Source = 2 invariant rows (identical
  // pixel content along the column), so stretching them produces a uniform
  // strip with stable bilinear sampling at the seams.
  if (midDestH > 0) {
    ctx.drawImage(cache, 0, SHADOW_CAP_TOP_H * dpr, srcW, SHADOW_MID_BAKE_H * dpr, dx, dy + SHADOW_CAP_TOP_H, SHADOW_BAKE_W, midDestH);
  }

  // Bottom cap — no stretching.
  ctx.drawImage(
    cache,
    0,
    (SHADOW_CAP_TOP_H + SHADOW_MID_BAKE_H) * dpr,
    srcW,
    SHADOW_CAP_BOT_H * dpr,
    dx,
    dy + SHADOW_CAP_TOP_H + midDestH,
    SHADOW_BAKE_W,
    SHADOW_CAP_BOT_H,
  );
}

function renderBookmarkBody(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, fillColor: string): void {
  drawBookmarkShadow(ctx, x, y, h);

  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.roundRect(x, y, BOOKMARK_WIDTH, h, BOOKMARK_CORNER_RADIUS);
  ctx.fill();
}

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
  /**
   * Pure cache read for the renderer hot path. Bookmark layouts are immutable
   * post-unfurl, so an existing entry is always valid; null means cold-miss.
   */
  getLayoutById(id: string): BookmarkLayout | null {
    return layoutCache.get(id) ?? null;
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
 * Frame describes the body (origin + width + height); bbox extends by the
 * asymmetric shadow pad. The painted shadow extent clamps to
 * SHADOW_H_MIN_SUPPORTED for very short bookmarks (unreachable in practice but
 * defensive): if `props.height < SHADOW_H_MIN_SUPPORTED`, `drawBookmarkShadow`
 * paints to `y + SHADOW_H_MIN_SUPPORTED + padBottom`, so bbox must cover that.
 */
export function computeBookmarkBBox(id: string, props: BookmarkProps): BBoxTuple {
  getLayout(id, props);
  const s = props.scale;
  const w = BOOKMARK_WIDTH * s;
  const h = props.height * s;
  const frame: FrameTuple = [props.origin[0], props.origin[1], w, h];
  bookmarkFrameCache.set(id, frame);
  const padTop = w * BOOKMARK_SHADOW_TOP_RATIO;
  const padSide = w * BOOKMARK_SHADOW_SIDE_RATIO;
  const padBottom = w * BOOKMARK_SHADOW_BOTTOM_RATIO;
  const paintedH = props.height < SHADOW_H_MIN_SUPPORTED ? SHADOW_H_MIN_SUPPORTED * s : h;
  return [frame[0] - padSide, frame[1] - padTop, frame[0] + w + padSide, frame[1] + paintedH + padBottom];
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
  const layout = bookmarkCache.getLayoutById(handle.id);
  if (!layout) return; // cold-miss race — observer fills the cache before render
  const r = readBookmarkRender(handle.y);

  ctx.save();
  ctx.translate(r.originX, r.originY);
  ctx.scale(r.scale, r.scale);

  renderBookmarkBody(ctx, 0, 0, r.height, CARD_FILL);

  if (layout.hasOgImage) {
    drawFullCard(ctx, BOOKMARK_WIDTH, layout, r.ogImageAssetId, r.faviconAssetId, hoveredOpen);
  } else if (layout.titleLines.length > 0) {
    drawTextCard(ctx, BOOKMARK_WIDTH, layout, r.faviconAssetId, hoveredOpen);
  }

  ctx.restore();
}

function drawFullCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  layout: BookmarkLayout,
  ogImageAssetId: string | undefined,
  faviconAssetId: string | undefined,
  hoveredOpen: boolean,
): void {
  const displayH = layout.ogDisplayH;

  // OG image (top, with rounded top corners)
  if (ogImageAssetId) {
    const bitmap = getBitmap(ogImageAssetId);
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
  drawBottomRow(ctx, textX, cursorY, textWidth, layout, faviconAssetId, false, hoveredOpen);
}

function drawTextCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  layout: BookmarkLayout,
  faviconAssetId: string | undefined,
  hoveredOpen: boolean,
): void {
  const textX = CARD_PADDING;
  const textWidth = w - CARD_PADDING * 2;
  let cursorY = CARD_PADDING;

  cursorY = drawTitleLines(ctx, textX, cursorY, layout.titleLines);
  if (layout.titleLines.length && layout.descLines.length) cursorY += SECTION_GAP;
  cursorY = drawDescLines(ctx, textX, cursorY, layout.descLines);
  if (layout.titleLines.length || layout.descLines.length) cursorY += SECTION_GAP;

  drawBottomRow(ctx, textX, cursorY, textWidth, layout, faviconAssetId, true, hoveredOpen);
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
