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
import type { BBoxTuple } from '@avlo/shared';

// =============================================================================
// FONT CONFIGURATION
// =============================================================================

export const FONT_CONFIG = {
  family: 'Grandstander',
  fallback: '"Grandstander", cursive, sans-serif',
  weightNormal: 550,
  weightBold: 800,
  lineHeightMultiplier: 1.3,
} as const;

// =============================================================================
// FONT METRICS (measured, not approximated)
// =============================================================================

let _measuredAscentRatio: number | null = null;

/**
 * Get the actual font ascent ratio by measuring with canvas.
 * Uses fontBoundingBoxAscent which is the same metric CSS uses.
 * Cached after first measurement.
 */
export function getMeasuredAscentRatio(): number {
  if (_measuredAscentRatio === null) {
    const ctx = getMeasureContext();
    // Use a large font size for accuracy, then compute ratio
    const testSize = 100;
    ctx.font = buildFontString(false, false, testSize);
    const metrics = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
    _measuredAscentRatio = metrics.fontBoundingBoxAscent / testSize;
  }
  return _measuredAscentRatio;
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
  inkBounds: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
}

export interface MeasuredLine {
  runs: MeasuredRun[];
  index: number;
  advanceWidth: number;
  inkBounds: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
  baselineY: number;      // Relative to text origin
  lineHeight: number;
  isEmpty: boolean;
}

export interface TextLayout {
  lines: MeasuredLine[];
  fontSize: number;
  lineHeight: number;
  inkBBox: { x: number; y: number; width: number; height: number };     // Actual drawn bounds
  logicalBBox: { x: number; y: number; width: number; height: number }; // Advance-based bounds
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

  // Track overall ink bounds
  let minInkX = Infinity;
  let maxInkX = -Infinity;
  let minInkY = Infinity;
  let maxInkY = -Infinity;

  // Track logical bounds (advance-based)
  let maxAdvanceWidth = 0;

  for (let lineIdx = 0; lineIdx < content.paragraphs.length; lineIdx++) {
    const paragraph = content.paragraphs[lineIdx];
    const baselineY = lineIdx * lineHeight; // First line baseline at origin (0)

    const measuredRuns: MeasuredRun[] = [];
    let lineAdvanceX = 0;

    // Line-level ink bounds (relative to baseline)
    let lineInkLeft = Infinity;
    let lineInkRight = -Infinity;
    let lineInkTop = Infinity;
    let lineInkBottom = -Infinity;

    if (paragraph.isEmpty) {
      // Empty line - use approximate bounds based on font size
      lines.push({
        runs: [],
        index: lineIdx,
        advanceWidth: 0,
        inkBounds: { left: 0, right: 0, top: -fontSize * getMeasuredAscentRatio(), bottom: fontSize * (1 - getMeasuredAscentRatio()) },
        baselineY,
        lineHeight,
        isEmpty: true,
      });

      // Update overall ink bounds for empty line
      const emptyInkTop = baselineY - fontSize * getMeasuredAscentRatio();
      const emptyInkBottom = baselineY + fontSize * (1 - getMeasuredAscentRatio());
      minInkY = Math.min(minInkY, emptyInkTop);
      maxInkY = Math.max(maxInkY, emptyInkBottom);
      minInkX = Math.min(minInkX, 0);
      maxInkX = Math.max(maxInkX, 0);

      continue;
    }

    for (const run of paragraph.runs) {
      const font = buildFontString(run.bold, run.italic, fontSize);
      ctx.font = font;

      const metrics = ctx.measureText(run.text);
      const advanceWidth = metrics.width;

      // Ink bounds from actualBoundingBox (relative to text draw position)
      // actualBoundingBoxLeft is positive leftward from origin
      // actualBoundingBoxRight is positive rightward from origin
      const inkLeft = -metrics.actualBoundingBoxLeft;
      const inkRight = metrics.actualBoundingBoxRight;
      const inkTop = -metrics.actualBoundingBoxAscent;
      const inkBottom = metrics.actualBoundingBoxDescent;

      measuredRuns.push({
        text: run.text,
        bold: run.bold,
        italic: run.italic,
        font,
        advanceWidth,
        advanceX: lineAdvanceX,
        inkBounds: {
          left: inkLeft,
          right: inkRight,
          top: inkTop,
          bottom: inkBottom,
        },
      });

      // Update line ink bounds (in world space relative to origin)
      lineInkLeft = Math.min(lineInkLeft, lineAdvanceX + inkLeft);
      lineInkRight = Math.max(lineInkRight, lineAdvanceX + inkRight);
      lineInkTop = Math.min(lineInkTop, inkTop);
      lineInkBottom = Math.max(lineInkBottom, inkBottom);

      lineAdvanceX += advanceWidth;
    }

    // Fix infinite bounds for non-empty lines with no actual ink
    if (lineInkLeft === Infinity) lineInkLeft = 0;
    if (lineInkRight === -Infinity) lineInkRight = lineAdvanceX;
    if (lineInkTop === Infinity) lineInkTop = -fontSize * getMeasuredAscentRatio();
    if (lineInkBottom === -Infinity) lineInkBottom = fontSize * (1 - getMeasuredAscentRatio());

    lines.push({
      runs: measuredRuns,
      index: lineIdx,
      advanceWidth: lineAdvanceX,
      inkBounds: {
        left: lineInkLeft,
        right: lineInkRight,
        top: lineInkTop,
        bottom: lineInkBottom,
      },
      baselineY,
      lineHeight,
      isEmpty: false,
    });

    // Update overall bounds
    maxAdvanceWidth = Math.max(maxAdvanceWidth, lineAdvanceX);
    minInkX = Math.min(minInkX, lineInkLeft);
    maxInkX = Math.max(maxInkX, lineInkRight);
    minInkY = Math.min(minInkY, baselineY + lineInkTop);
    maxInkY = Math.max(maxInkY, baselineY + lineInkBottom);
  }

  // Handle edge case: all empty lines
  if (minInkX === Infinity) minInkX = 0;
  if (maxInkX === -Infinity) maxInkX = 0;
  if (minInkY === Infinity) minInkY = 0;
  if (maxInkY === -Infinity) maxInkY = fontSize;

  // Compute bboxes relative to origin (0, 0)
  const inkBBox = {
    x: minInkX,
    y: minInkY,
    width: maxInkX - minInkX,
    height: maxInkY - minInkY,
  };

  const totalHeight = lines.length * lineHeight;
  const logicalBBox = {
    x: 0,
    y: 0,
    width: maxAdvanceWidth,
    height: totalHeight,
  };

  return {
    lines,
    fontSize,
    lineHeight,
    inkBBox,
    logicalBBox,
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
 */
export function renderTextLayout(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  originX: number,
  originY: number,
  color: string
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';

  for (const line of layout.lines) {
    if (line.isEmpty) continue;

    const lineY = originY + line.baselineY;

    for (const run of line.runs) {
      ctx.font = run.font;
      ctx.fillText(run.text, originX + run.advanceX, lineY);
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
 */
export function computeTextBBox(
  objectId: string,
  fragment: Y.XmlFragment,
  fontSize: number,
  origin: [number, number]
): BBoxTuple {
  const layout = textLayoutCache.getLayout(objectId, fragment, fontSize);
  const [ox, oy] = origin;

  // Use ink bbox for accurate dirty rect tracking
  // Add small padding for safety
  const padding = 2;
  return [
    ox + layout.inkBBox.x - padding,
    oy + layout.inkBBox.y - padding,
    ox + layout.inkBBox.x + layout.inkBBox.width + padding,
    oy + layout.inkBBox.y + layout.inkBBox.height + padding,
  ];
}
