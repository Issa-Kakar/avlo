/**
 * TEXT MANAGEMENT SYSTEM
 *
 * Consolidated file for rich text layout:
 * - Font configuration
 * - Font string builder
 * - Parser (Y.XmlFragment → ParsedContent)
 * - Layout engine (ParsedContent → TextLayout)
 * - Cache (TextLayoutCache)
 * - Renderer (renderTextLayout)
 */

import * as Y from 'yjs';
import type { BBoxTuple, FrameTuple } from '@avlo/shared';
import { expandBBox } from '@/lib/geometry/bounds';
import { areFontsLoaded } from './font-loader';
import { FONT_CONFIG } from './font-config';

// Re-export for consumers
export { FONT_CONFIG } from './font-config';

// =============================================================================
// TEXT ALIGNMENT HELPERS
// =============================================================================

export type TextAlign = 'left' | 'center' | 'right';

/**
 * Returns the anchor factor for alignment:
 * - left: 0 (origin at left edge)
 * - center: 0.5 (origin at center)
 * - right: 1 (origin at right edge)
 */
export function anchorFactor(align: TextAlign): number {
  return align === 'left' ? 0 : align === 'center' ? 0.5 : 1;
}

/**
 * Compute the X position where a line starts drawing, given:
 * - originX: the anchor point X coordinate
 * - lineWidth: the advance width of the line
 * - align: text alignment
 *
 * For left-aligned text, line starts at originX.
 * For center-aligned text, line starts at originX - lineWidth/2.
 * For right-aligned text, line starts at originX - lineWidth.
 */
export function lineStartX(originX: number, lineWidth: number, align: TextAlign): number {
  if (align === 'left') return originX;
  if (align === 'center') return originX - lineWidth / 2;
  return originX - lineWidth;
}

// =============================================================================
// FONT METRICS (measured, not approximated)
// =============================================================================

let _measuredAscentRatio: number | null = null;

/** Known fallback value for Grandstander (used if fonts not loaded yet) */
const FALLBACK_ASCENT_RATIO = 0.73;

/**
 * Get the actual font ascent ratio by measuring with canvas.
 * Uses fontBoundingBoxAscent which is the same metric CSS uses.
 * Cached after first measurement.
 */
export function getMeasuredAscentRatio(): number {
  if (_measuredAscentRatio !== null) {
    return _measuredAscentRatio;
  }

  // CRITICAL: If fonts not loaded, we'd measure "cursive" fallback (wrong!)
  if (!areFontsLoaded()) {
    console.warn('[text-system] getMeasuredAscentRatio called before fonts loaded! Using fallback.');
    return FALLBACK_ASCENT_RATIO;
  }

  const ctx = getMeasureContext();
  const testSize = 100;
  ctx.font = buildFontString(false, false, testSize);
  const metrics = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');

  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  const totalHeight = ascent + descent;

  // Handle fonts that include line-gap in metrics:
  // If totalHeight > fontSize, derive em-box ratio proportionally
  const tolerance = testSize * 0.01;
  if (Math.abs(totalHeight - testSize) < tolerance) {
    // Pure em-box metrics
    _measuredAscentRatio = ascent / testSize;
  } else {
    // Font includes line-gap: use proportion
    _measuredAscentRatio = ascent / totalHeight;
  }

  // eslint-disable-next-line no-console
  console.log(`[text-system] Measured ascent ratio: ${_measuredAscentRatio.toFixed(4)}`);
  return _measuredAscentRatio;
}

/**
 * Reset cached font metrics. Call after fonts finish loading.
 */
export function resetFontMetrics(): void {
  _measuredAscentRatio = null;
}

/**
 * Get the offset from baseline to DOM container top (as ratio of fontSize).
 * This is the exact distance needed to position a DOM element
 * so its text baseline lands at a specific Y coordinate.
 *
 * Formula: halfLeading + fontAscent
 *        = (lineHeightMultiplier - 1) / 2 + measuredAscentRatio
 */
export function getBaselineToTopRatio(): number {
  const halfLeadingRatio = (FONT_CONFIG.lineHeightMultiplier - 1) / 2;
  return halfLeadingRatio + getMeasuredAscentRatio();
}

// =============================================================================
// FONT STRING BUILDER
// =============================================================================

export function buildFontString(bold: boolean, italic: boolean, fontSize: number): string {
  const weight = bold ? FONT_CONFIG.weightBold : FONT_CONFIG.weightNormal;
  const style = italic ? 'italic' : 'normal';
  return `${style} ${weight} ${fontSize}px ${FONT_CONFIG.fallback}`;
}

// =============================================================================
// PARSED TYPES (from Y.XmlFragment)
// =============================================================================

export interface ParsedRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

export interface ParsedParagraph {
  runs: ParsedRun[];
  isEmpty: boolean;
}

export interface ParsedContent {
  paragraphs: ParsedParagraph[];
  structuralHash: number;
  charCount: number;
}

// =============================================================================
// MEASURED/LAYOUT TYPES
// =============================================================================

export interface MeasuredRun {
  text: string;
  bold: boolean;
  italic: boolean;
  font: string;           // Pre-computed ctx.font string
  advanceWidth: number;   // Total advance width of run
  advanceX: number;       // X offset from line start
}

export interface MeasuredLine {
  runs: MeasuredRun[];
  index: number;
  advanceWidth: number;
  inkBounds: BBoxTuple;   // [left, top, right, bottom] relative to baseline
  baselineY: number;      // Relative to text origin
  lineHeight: number;
  isEmpty: boolean;
}

export interface TextLayout {
  lines: MeasuredLine[];
  fontSize: number;
  lineHeight: number;
  inkBBox: FrameTuple;     // [x, y, w, h] actual drawn bounds
  logicalBBox: FrameTuple; // [x, y, w, h] advance-based bounds
  structuralHash: number;
}

// =============================================================================
// MEASUREMENT CONTEXT (singleton canvas for text measurement)
// =============================================================================

let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create measurement context');
    ctx.textRendering = 'optimizeSpeed';
    measureCtx = ctx;
  }
  return measureCtx;
}

// =============================================================================
// PARSER: Y.XmlFragment → ParsedContent
// =============================================================================

/**
 * Simple hash function for structural change detection.
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash | 0; // Convert to 32-bit integer
  }
  return hash;
}

/**
 * Parse Y.XmlFragment into structured content.
 * Handles Tiptap/ProseMirror document structure:
 * - Y.XmlElement('paragraph') contains Y.XmlText children
 * - Y.XmlText.toDelta() returns rich text operations
 */
export function parseYXmlFragment(fragment: Y.XmlFragment): ParsedContent {
  const paragraphs: ParsedParagraph[] = [];
  let charCount = 0;
  let hashInput = '';

  // Walk children (each should be a paragraph)
  const children = fragment.toArray();

  if (children.length === 0) {
    // Empty fragment → one empty paragraph
    paragraphs.push({ runs: [], isEmpty: true });
  } else {
    for (const child of children) {
      if (child instanceof Y.XmlElement && child.nodeName === 'paragraph') {
        const runs: ParsedRun[] = [];
        let paragraphText = '';

        // Get text content from paragraph
        const paragraphChildren = child.toArray();

        for (const textNode of paragraphChildren) {
          if (textNode instanceof Y.XmlText) {
            // Get delta for rich text formatting
            const delta = textNode.toDelta();

            for (const op of delta) {
              if (typeof op.insert === 'string') {
                const text = op.insert;
                const attrs = op.attributes || {};
                const bold = !!attrs.bold;
                const italic = !!attrs.italic;

                // Coalesce with previous run if same styling
                const lastRun = runs[runs.length - 1];
                if (lastRun && lastRun.bold === bold && lastRun.italic === italic) {
                  lastRun.text += text;
                } else {
                  runs.push({ text, bold, italic });
                }

                paragraphText += text;
                charCount += text.length;
              }
            }
          }
        }

        hashInput += paragraphText + '\n';
        paragraphs.push({
          runs,
          isEmpty: runs.length === 0 || paragraphText.length === 0,
        });
      }
    }
  }

  // Ensure at least one paragraph
  if (paragraphs.length === 0) {
    paragraphs.push({ runs: [], isEmpty: true });
  }

  return {
    paragraphs,
    structuralHash: simpleHash(hashInput),
    charCount,
  };
}

// =============================================================================
// LAYOUT ENGINE: ParsedContent → TextLayout
// =============================================================================

/**
 * Layout content at a given font size.
 * Measures all runs and computes line positions.
 */
export function layoutContent(content: ParsedContent, fontSize: number): TextLayout {
  const ctx = getMeasureContext();
  const lineHeight = fontSize * FONT_CONFIG.lineHeightMultiplier;
  const lines: MeasuredLine[] = [];
  const ascentY = fontSize * getMeasuredAscentRatio();
  const descentY = fontSize - ascentY;

  // Overall ink bounds accumulator
  const ink: BBoxTuple = [Infinity, Infinity, -Infinity, -Infinity];
  let maxAdvanceWidth = 0;

  for (let lineIdx = 0; lineIdx < content.paragraphs.length; lineIdx++) {
    const paragraph = content.paragraphs[lineIdx];
    const baselineY = lineIdx * lineHeight;

    if (paragraph.isEmpty) {
      lines.push({
        runs: [],
        index: lineIdx,
        advanceWidth: 0,
        inkBounds: [0, -ascentY, 0, descentY],
        baselineY,
        lineHeight,
        isEmpty: true,
      });
      expandBBox(ink, 0, baselineY - ascentY, 0, baselineY + descentY);
      continue;
    }

    const measuredRuns: MeasuredRun[] = [];
    let lineAdvanceX = 0;
    const li: BBoxTuple = [Infinity, Infinity, -Infinity, -Infinity];

    for (const run of paragraph.runs) {
      const font = buildFontString(run.bold, run.italic, fontSize);
      ctx.font = font;
      const m = ctx.measureText(run.text);

      measuredRuns.push({ ...run, font, advanceWidth: m.width, advanceX: lineAdvanceX });
      expandBBox(li, lineAdvanceX - m.actualBoundingBoxLeft, -m.actualBoundingBoxAscent,
                     lineAdvanceX + m.actualBoundingBoxRight, m.actualBoundingBoxDescent);
      lineAdvanceX += m.width;
    }

    if (!isFinite(li[0])) { li[0] = 0; li[1] = -ascentY; li[2] = lineAdvanceX; li[3] = descentY; }

    lines.push({
      runs: measuredRuns,
      index: lineIdx,
      advanceWidth: lineAdvanceX,
      inkBounds: li,
      baselineY,
      lineHeight,
      isEmpty: false,
    });

    maxAdvanceWidth = Math.max(maxAdvanceWidth, lineAdvanceX);
    expandBBox(ink, li[0], baselineY + li[1], li[2], baselineY + li[3]);
  }

  if (!isFinite(ink[0])) { ink[0] = 0; ink[1] = 0; ink[2] = 0; ink[3] = fontSize; }

  return {
    lines,
    fontSize,
    lineHeight,
    inkBBox: [ink[0], ink[1], ink[2] - ink[0], ink[3] - ink[1]],
    logicalBBox: [0, 0, maxAdvanceWidth, lines.length * lineHeight],
    structuralHash: content.structuralHash,
  };
}

// =============================================================================
// CACHE: TextLayoutCache
// =============================================================================

interface CacheEntry {
  parsed: ParsedContent;
  layout: TextLayout;
  layoutFontSize: number;
  frame: FrameTuple | null;  // Derived world-coords frame, set by computeTextBBox
}

class TextLayoutCache {
  private cache = new Map<string, CacheEntry>();

  /**
   * Get or compute layout for a text object.
   * Caches both parsed content and layout.
   */
  getLayout(objectId: string, fragment: Y.XmlFragment, fontSize: number): TextLayout {
    const entry = this.cache.get(objectId);

    if (entry && entry.layoutFontSize === fontSize) {
      // Cache hit - same font size
      return entry.layout;
    }

    if (entry && entry.layoutFontSize !== fontSize) {
      // Font size changed - re-layout with existing parsed content
      const layout = layoutContent(entry.parsed, fontSize);
      entry.layout = layout;
      entry.layoutFontSize = fontSize;
      return layout;
    }

    // Cache miss - parse and layout
    const parsed = parseYXmlFragment(fragment);
    const layout = layoutContent(parsed, fontSize);

    this.cache.set(objectId, {
      parsed,
      layout,
      layoutFontSize: fontSize,
      frame: null,
    });

    return layout;
  }

  /**
   * Full invalidation - content changed.
   */
  invalidate(objectId: string): void {
    this.cache.delete(objectId);
  }

  /**
   * Layout-only invalidation - fontSize changed.
   * Clears layout but keeps parsed content for next getLayout call.
   */
  invalidateLayout(objectId: string): void {
    const entry = this.cache.get(objectId);
    if (entry) {
      // Mark layout as stale by setting fontSize to -1
      entry.layoutFontSize = -1;
      entry.frame = null;
    }
  }

  /**
   * Clear entire cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Check if object is cached.
   */
  has(objectId: string): boolean {
    return this.cache.has(objectId);
  }

  /**
   * Set the derived frame for a text object.
   */
  setFrame(objectId: string, frame: FrameTuple): void {
    const entry = this.cache.get(objectId);
    if (entry) entry.frame = frame;
  }

  /**
   * Get the derived frame for a text object.
   */
  getFrame(objectId: string): FrameTuple | null {
    return this.cache.get(objectId)?.frame ?? null;
  }
}

// Singleton instance
export const textLayoutCache = new TextLayoutCache();

// =============================================================================
// RENDERER: renderTextLayout
// =============================================================================

/**
 * Render a text layout to canvas.
 * Origin is the baseline position of the first line.
 * Text ink extends above origin (ascent) and below (descent).
 *
 * @param align - Text alignment. The originX parameter is the alignment anchor:
 *   - 'left': originX is the left edge of the text
 *   - 'center': originX is the center of the text
 *   - 'right': originX is the right edge of the text
 */
export function renderTextLayout(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  originX: number,
  originY: number,
  color: string,
  align: TextAlign = 'left'
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textRendering = 'optimizeSpeed';
  for (const line of layout.lines) {
    if (line.isEmpty) continue;

    const lineY = originY + line.baselineY;
    // Compute line start X based on alignment
    const startX = lineStartX(originX, line.advanceWidth, align);

    for (const run of line.runs) {
      ctx.font = run.font;
      ctx.fillText(run.text, startX + run.advanceX, lineY);
    }
  }

  ctx.restore();
}

// =============================================================================
// BBOX COMPUTATION: computeTextBBox
// =============================================================================

/**
 * Compute bounding box for a text object.
 * Used by room-doc-manager for spatial index.
 *
 * @param align - Text alignment affects how origin maps to actual ink bounds:
 *   - 'left': origin is the left edge
 *   - 'center': origin is the center
 *   - 'right': origin is the right edge
 */
export function computeTextBBox(
  objectId: string,
  fragment: Y.XmlFragment,
  fontSize: number,
  origin: [number, number],
  align: TextAlign = 'left',
  fixedWidth: number | null = null
): BBoxTuple {
  const layout = textLayoutCache.getLayout(objectId, fragment, fontSize);
  const [ox, oy] = origin;
  const [, inkY, , inkH] = layout.inkBBox;
  const padding = 2;
  let minX = Infinity;
  let maxX = -Infinity;

  for (const line of layout.lines) {
    const startX = lineStartX(ox, line.advanceWidth, align);
    minX = Math.min(minX, startX + line.inkBounds[0]);
    maxX = Math.max(maxX, startX + line.inkBounds[2]);
  }

  if (!isFinite(minX)) { minX = ox; maxX = ox; }

  // Compute and cache the derived frame (world coordinates)
  const fw = fixedWidth ?? layout.logicalBBox[2];
  const fx = ox - anchorFactor(align) * fw;
  const fy = oy - fontSize * getBaselineToTopRatio();
  textLayoutCache.setFrame(objectId, [fx, fy, fw, layout.logicalBBox[3]]);

  return [
    minX - padding,
    oy + inkY - padding,
    maxX + padding,
    oy + inkY + inkH + padding,
  ];
}

/**
 * Get the derived frame for a text object from the layout cache.
 * Returns null if the object hasn't been through computeTextBBox yet.
 */
export function getTextFrame(objectId: string): FrameTuple | null {
  return textLayoutCache.getFrame(objectId);
}
