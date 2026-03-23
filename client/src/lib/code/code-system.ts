/**
 * Code System — Cache, Layout, Worker Pool, Font Metrics, Renderer
 *
 * Two-tier tokenization: sync regex (floor) + Lezer worker (ceiling).
 * RunSpans model: flat Uint16Array of [offset, length, styleIndex] triples per line.
 * Proportional padding (fontSize-relative) + measured font metrics for pixel-perfect alignment.
 */

import type { BBoxTuple, FrameTuple } from '@avlo/shared';
import type { CodeLanguage } from '@avlo/shared';
import { getCodeProps } from '@avlo/shared';
import * as Y from 'yjs';
import { invalidateWorld } from '@/canvas/invalidation-helpers';
import { frameTupleToWorldBounds } from '@/lib/geometry/bounds';
import {
  getMeasuredAscentRatio,
  getMeasuredDescentRatio,
  getMinCharWidthRatio,
} from '@/lib/text/text-system';

import {
  type RunSpans,
  PALETTE,
  isBold,
  syncTokenize,
  CODE_BG,
  CODE_DEFAULT,
  CODE_GUTTER,
  CODE_FONT_FAMILY,
  LINE_HEIGHT_MULT,
  CHROME_FONT_RATIO,
  HEADER_HEIGHT_RATIO,
  OUTPUT_LABEL_H_RATIO,
  OUTPUT_LINE_H_MULT,
  OUTPUT_PAD_BOTTOM_RATIO,
  MAX_OUTPUT_CANVAS_LINES,
  CODE_SEPARATOR,
  CODE_TITLE_COLOR,
  CODE_PLAY_GREEN,
  CODE_PLAY_BG,
  CODE_OUTPUT_LABEL,
} from './code-tokens';

// ============================================================================
// §1 TYPES
// ============================================================================

export interface VisualLine {
  srcIdx: number; // Source line index (always valid)
  from: number; // Char offset in source line (0 = first segment → show gutter)
  text: string; // Visual line text
}

export interface CodeLayout {
  lines: VisualLine[];
  sourceLineCount: number;
  totalWidth: number;
  lineNumbers: boolean;
}

interface CacheEntry {
  sourceLines: string[];
  version: number;
  spans: RunSpans[];
  layout: CodeLayout | null;
  layoutFontSize: number;
  layoutWidth: number;
  layoutLineNumbers: boolean;
  language: CodeLanguage;
  frame: FrameTuple | null;
}

export interface ChangedRange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

type WorkerRequest =
  | {
      type: 'parse';
      id: string;
      text: string;
      language: CodeLanguage;
      version: number;
      changes?: ChangedRange[];
    }
  | { type: 'remove'; id: string }
  | { type: 'clearAll' };

interface WorkerResponse {
  type: 'spans';
  id: string;
  version: number;
  spans: RunSpans[];
}

// ============================================================================
// §2 CONSTANTS
// ============================================================================

export const DEFAULT_FONT_SIZE = 14;
export const MIN_CHARS = 20;
export const DEFAULT_CHARS = 50;

export const FONT_WEIGHT = 450;
export const FONT_WEIGHT_BOLD = 700;
export const CODE_FONT = `'${CODE_FONT_FAMILY}', monospace`;

const PAD_TOP_RATIO = 1.5;
const PAD_BOTTOM_RATIO = 1.5;
const PAD_LEFT_RATIO = 1.0;
const PAD_RIGHT_RATIO = 0.85;
const GUTTER_PAD_RATIO = 2.2;
const BORDER_RADIUS_RATIO = 0.85;

// ============================================================================
// §3 FONT METRICS & HELPERS
// ============================================================================
// Metrics derived from text-system's per-font measurement cache.
// JetBrains Mono is true monospace — advance width identical across all weights,
// so getMinCharWidthRatio (bold 'W') equals any-weight any-glyph advance.

export function padTop(fs: number): number {
  return fs * PAD_TOP_RATIO;
}
export function padBottom(fs: number): number {
  return fs * PAD_BOTTOM_RATIO;
}
export function padLeft(fs: number): number {
  return fs * PAD_LEFT_RATIO;
}
export function padRight(fs: number): number {
  return fs * PAD_RIGHT_RATIO;
}
export function gutterPad(fs: number): number {
  return fs * GUTTER_PAD_RATIO;
}
export function borderRadius(fs: number): number {
  return fs * BORDER_RADIUS_RATIO;
}

export function charWidth(fontSize: number): number {
  return fontSize * getMinCharWidthRatio('JetBrains Mono');
}

export function lineHeight(fontSize: number): number {
  return fontSize * LINE_HEIGHT_MULT;
}

/** CSS half-leading baseline: (lineHeight + ascent - descent) / 2 from top. */
export function baselineOffset(fontSize: number): number {
  const a = getMeasuredAscentRatio('JetBrains Mono');
  const d = getMeasuredDescentRatio('JetBrains Mono');
  return (fontSize * (LINE_HEIGHT_MULT + a - d)) / 2;
}

export function gutterWidth(maxDigits: number, fontSize: number): number {
  return maxDigits * charWidth(fontSize);
}

export function contentLeft(maxDigits: number, fontSize: number, lineNumbers = true): number {
  if (!lineNumbers) return padLeft(fontSize);
  return padLeft(fontSize) + gutterWidth(maxDigits, fontSize) + gutterPad(fontSize);
}

export function getMinWidth(fontSize: number): number {
  const cw = charWidth(fontSize);
  return (
    MIN_CHARS * cw +
    padLeft(fontSize) +
    padRight(fontSize) +
    gutterWidth(2, fontSize) +
    gutterPad(fontSize)
  );
}

export function getDefaultWidth(fontSize: number): number {
  const cw = charWidth(fontSize);
  return (
    DEFAULT_CHARS * cw +
    padLeft(fontSize) +
    padRight(fontSize) +
    gutterWidth(2, fontSize) +
    gutterPad(fontSize)
  );
}

// ============================================================================
// §4 LAYOUT
// ============================================================================

export function computeLayout(
  sourceLines: string[],
  fontSize: number,
  width: number,
  lineNumbers = true,
): CodeLayout {
  const sourceLineCount = sourceLines.length;
  const digits = Math.max(2, String(sourceLineCount).length);
  const cl = contentLeft(digits, fontSize, lineNumbers);
  const cw = charWidth(fontSize);
  const maxChars = Math.max(1, Math.floor((width - cl - padRight(fontSize)) / cw));

  const lines: VisualLine[] = [];
  for (let i = 0; i < sourceLines.length; i++) {
    const text = sourceLines[i];
    if (text.length <= maxChars) {
      lines.push({ srcIdx: i, from: 0, text });
      continue;
    }
    // Word-aware wrapping matching CSS break-spaces + overflow-wrap: anywhere
    let pos = 0;
    while (pos < text.length) {
      if (text.length - pos <= maxChars) {
        lines.push({ srcIdx: i, from: pos, text: text.slice(pos) });
        break;
      }
      // Scan backward for last space/tab break opportunity within window
      let breakAt = -1;
      for (let j = pos + maxChars - 1; j >= pos; j--) {
        const c = text.charCodeAt(j);
        if (c === 32 || c === 9) {
          breakAt = j + 1;
          break;
        }
      }
      if (breakAt === -1) breakAt = pos + maxChars; // character-level fallback
      lines.push({ srcIdx: i, from: pos, text: text.slice(pos, breakAt) });
      pos = breakAt;
    }
  }

  return { lines, sourceLineCount, totalWidth: width, lineNumbers };
}

/** Compute total height from layout + fontSize — not stored. */
export function totalHeight(layout: CodeLayout, fontSize: number): number {
  return padTop(fontSize) + layout.lines.length * lineHeight(fontSize) + padBottom(fontSize);
}

// ============================================================================
// §4b CHROME HEIGHT HELPERS — header bar + output panel
// ============================================================================

export function chromeFontSize(fs: number): number {
  return fs * CHROME_FONT_RATIO;
}

export function headerBarHeight(fs: number): number {
  return fs * HEADER_HEIGHT_RATIO;
}

export function outputPanelHeight(fs: number, output: string | undefined): number {
  const cfs = chromeFontSize(fs);
  const outputLH = cfs * OUTPUT_LINE_H_MULT;
  const labelH = fs * OUTPUT_LABEL_H_RATIO;
  const padB = fs * OUTPUT_PAD_BOTTOM_RATIO;
  if (!output) return labelH + padB;
  const lineCount = Math.min(output.split('\n').length, MAX_OUTPUT_CANVAS_LINES);
  return labelH + lineCount * outputLH + padB;
}

/** Full block height including header + code content + output panel. */
export function blockHeight(
  layout: CodeLayout,
  fontSize: number,
  headerVisible: boolean,
  outputVisible: boolean,
  output: string | undefined,
): number {
  return (
    (headerVisible ? headerBarHeight(fontSize) : 0) +
    padTop(fontSize) +
    layout.lines.length * lineHeight(fontSize) +
    padBottom(fontSize) +
    (outputVisible ? outputPanelHeight(fontSize, output) : 0)
  );
}

// ============================================================================
// §5 WORKER POOL — Warm, Persistent, Hash-Based Routing
// ============================================================================

const POOL_SIZE = 2;
const workers: Worker[] = [];
let workersReady = false;

/** Deterministic hash: same object always goes to the same worker (preserves incremental parse trees). */
function workerFor(id: string): number {
  return id.charCodeAt(id.length - 1) % POOL_SIZE;
}

function ensureWorkers(): void {
  if (workersReady) return;
  workersReady = true;
  for (let i = 0; i < POOL_SIZE; i++) {
    const w = new Worker(new URL('./lezer-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = handleWorkerMessage;
    workers.push(w);
  }
}

function dispatch(msg: WorkerRequest): void {
  ensureWorkers();
  if (msg.type === 'clearAll') {
    // Broadcast to ALL workers (fixes bug where only one got cleared)
    for (const w of workers) w.postMessage(msg);
    return;
  }
  // Route by object ID hash for parse/remove
  workers[workerFor(msg.id)].postMessage(msg);
}

function handleWorkerMessage(e: MessageEvent<WorkerResponse>): void {
  const { id, version, spans } = e.data;
  codeSystem.applyWorkerSpans(id, spans, version);
}

function requestParse(
  id: string,
  text: string,
  language: CodeLanguage,
  version: number,
  changes?: ChangedRange[],
): void {
  dispatch({ type: 'parse', id, text, language, version, changes });
}

function requestRemove(id: string): void {
  if (!workersReady) return;
  dispatch({ type: 'remove', id });
}

function requestClearAll(): void {
  if (!workersReady) return;
  dispatch({ type: 'clearAll' });
}

// ============================================================================
// §6 DELTA CONVERSION
// ============================================================================

/**
 * Convert Y.Text delta to ChangedRange[] for incremental Lezer parsing.
 */
export function deltaToChangedRanges(
  delta: { insert?: string | object; delete?: number; retain?: number }[],
): ChangedRange[] {
  const ranges: ChangedRange[] = [];
  let posOld = 0;
  let posNew = 0;

  for (const op of delta) {
    if (op.retain) {
      posOld += op.retain;
      posNew += op.retain;
    } else if (op.delete) {
      const len = op.delete;
      ranges.push({ fromA: posOld, toA: posOld + len, fromB: posNew, toB: posNew });
      posOld += len;
    } else if (op.insert) {
      const text = typeof op.insert === 'string' ? op.insert : '';
      const len = text.length;
      ranges.push({ fromA: posOld, toA: posOld, fromB: posNew, toB: posNew + len });
      posNew += len;
    }
  }

  // Merge adjacent ranges (select+type/paste → delete+insert at same position)
  let wi = 0;
  for (let i = 0; i < ranges.length; i++) {
    if (
      wi > 0 &&
      ranges[wi - 1].toA === ranges[i].fromA &&
      ranges[wi - 1].toB === ranges[i].fromB
    ) {
      ranges[wi - 1].toA = ranges[i].toA;
      ranges[wi - 1].toB = ranges[i].toB;
    } else {
      ranges[wi++] = ranges[i];
    }
  }
  ranges.length = wi;

  return ranges;
}

// ============================================================================
// §7 CACHE
// ============================================================================

class CodeSystemCache {
  private entries = new Map<string, CacheEntry>();

  getLayout(
    id: string,
    yText: Y.Text,
    fontSize: number,
    width: number,
    language: CodeLanguage,
    lineNumbers = true,
  ): CodeLayout {
    let e = this.entries.get(id);

    // COLD MISS — build full entry from Y.Text
    if (!e) {
      const text = yText.toString();
      const sourceLines = text.split('\n');
      const spans = syncTokenize(sourceLines, language);
      const layout = computeLayout(sourceLines, fontSize, width, lineNumbers);
      e = {
        sourceLines,
        version: 1,
        spans,
        layout,
        layoutFontSize: fontSize,
        layoutWidth: width,
        layoutLineNumbers: lineNumbers,
        language,
        frame: null,
      };
      this.entries.set(id, e);
      requestParse(id, text, language, e.version);
      return layout;
    }

    // Language changed — re-tokenize spans only, keep layout if dims unchanged
    if (e.language !== language) {
      e.spans = syncTokenize(e.sourceLines, language);
      e.language = language;
      e.version++;
      requestParse(id, e.sourceLines.join('\n'), language, e.version);
      // Only recompute layout if fontSize/width/lineNumbers also changed
      if (
        !e.layout ||
        e.layoutFontSize !== fontSize ||
        e.layoutWidth !== width ||
        e.layoutLineNumbers !== lineNumbers
      ) {
        e.layoutFontSize = fontSize;
        e.layoutWidth = width;
        e.layoutLineNumbers = lineNumbers;
        e.frame = null;
        e.layout = computeLayout(e.sourceLines, fontSize, width, lineNumbers);
      }
      return e.layout;
    }

    // Cached layout still valid?
    if (
      e.layout &&
      e.layoutFontSize === fontSize &&
      e.layoutWidth === width &&
      e.layoutLineNumbers === lineNumbers
    ) {
      return e.layout;
    }

    // Relayout needed (fontSize, width, or lineNumbers changed)
    if (
      e.layoutFontSize !== fontSize ||
      e.layoutWidth !== width ||
      e.layoutLineNumbers !== lineNumbers
    ) {
      e.layoutFontSize = fontSize;
      e.layoutWidth = width;
      e.layoutLineNumbers = lineNumbers;
      e.frame = null;
    }
    e.layout = computeLayout(e.sourceLines, fontSize, width, lineNumbers);
    return e.layout;
  }

  /**
   * Called synchronously from deep observer on Y.Text change.
   * Runs sync tokenizer → dispatches to Lezer worker.
   */
  handleContentChange(id: string, ev: Y.YTextEvent, language: CodeLanguage): void {
    const yText = ev.target as Y.Text;
    const text = yText.toString();
    const sourceLines = text.split('\n');
    const spans = syncTokenize(sourceLines, language);

    let e = this.entries.get(id);
    if (e) {
      e.sourceLines = sourceLines;
      e.version++;
      e.spans = spans;
      e.layout = null;
      e.frame = null;
    } else {
      e = {
        sourceLines,
        version: 1,
        spans,
        layout: null,
        layoutFontSize: 0,
        layoutWidth: 0,
        layoutLineNumbers: true,
        language,
        frame: null,
      };
      this.entries.set(id, e);
    }

    const changes = deltaToChangedRanges(
      ev.delta as { insert?: string | object; delete?: number; retain?: number }[],
    );
    requestParse(id, text, language, e.version, changes.length > 0 ? changes : undefined);
  }

  /**
   * Apply Lezer worker spans (ceiling upgrade). Version-gated to discard stale results.
   */
  applyWorkerSpans(id: string, spans: RunSpans[], forVersion: number): void {
    const e = this.entries.get(id);
    if (!e || forVersion !== e.version) return;
    e.spans = spans;
    // Layout dimensions unchanged — only colors differ. No layout null.
    // Trigger redraw if frame is known
    if (e.frame) {
      invalidateWorld(frameTupleToWorldBounds(e.frame));
    }
  }

  getSpans(id: string): RunSpans[] {
    return this.entries.get(id)?.spans ?? [];
  }

  getSourceLines(id: string): string[] {
    return this.entries.get(id)?.sourceLines ?? [];
  }

  setFrame(id: string, frame: FrameTuple): void {
    const e = this.entries.get(id);
    if (e) e.frame = frame;
  }

  getFrame(id: string): FrameTuple | null {
    return this.entries.get(id)?.frame ?? null;
  }

  remove(id: string): void {
    this.entries.delete(id);
    requestRemove(id);
  }

  clear(): void {
    this.entries.clear();
    requestClearAll();
  }
}

// Singleton
export const codeSystem = new CodeSystemCache();

// ============================================================================
// §8 PUBLIC API
// ============================================================================

/** Get derived frame for a code object. Mirrors getTextFrame() pattern. */
export function getCodeFrame(id: string): FrameTuple | null {
  return codeSystem.getFrame(id);
}

/** Compute bbox for a code object — frame→bbox conversion. */
export function computeCodeBBox(id: string, yObj: Y.Map<unknown>): BBoxTuple {
  const props = getCodeProps(yObj);
  if (!props) {
    const origin = (yObj.get('origin') as [number, number]) ?? [0, 0];
    return [origin[0], origin[1], origin[0] + 1, origin[1] + 1];
  }
  const layout = codeSystem.getLayout(
    id,
    props.content,
    props.fontSize,
    props.width,
    props.language,
    props.lineNumbers,
  );
  const [ox, oy] = props.origin;
  const bh = blockHeight(layout, props.fontSize, props.headerVisible, props.outputVisible, props.output);
  const frame: FrameTuple = [ox, oy, layout.totalWidth, bh];
  codeSystem.setFrame(id, frame);
  return [ox, oy, ox + layout.totalWidth, oy + bh];
}

// ============================================================================
// §9 CANVAS RENDERER — Zero-Allocation Span Iteration
// ============================================================================

/**
 * Render a code layout onto the canvas using RunSpans (packed Uint16Array triples).
 * No intermediate object allocation — iterates spans inline with offset clipping for wrapping.
 */
export function renderCodeLayout(
  ctx: CanvasRenderingContext2D,
  layout: CodeLayout,
  originX: number,
  originY: number,
  fontSize: number,
  spans: RunSpans[],
  sourceLines: string[],
  title?: string,
  output?: string,
): void {
  const lh = lineHeight(fontSize);
  const cw = charWidth(fontSize);
  const pt = padTop(fontSize);
  const pl = padLeft(fontSize);
  const hh = title !== undefined ? headerBarHeight(fontSize) : 0;
  const bgH = blockHeight(
    layout, fontSize, title !== undefined, output !== undefined, output,
  );
  const digits = Math.max(2, String(layout.sourceLineCount).length);
  const cl = contentLeft(digits, fontSize, layout.lineNumbers);
  const normalFont = `${FONT_WEIGHT} ${fontSize}px ${CODE_FONT}`;
  const boldFont = `${FONT_WEIGHT_BOLD} ${fontSize}px ${CODE_FONT}`;
  const cfs = chromeFontSize(fontSize);
  const chromeFont = `${FONT_WEIGHT} ${cfs}px ${CODE_FONT}`;

  ctx.save();

  // 1. Background
  ctx.fillStyle = CODE_BG;
  ctx.beginPath();
  ctx.roundRect(originX, originY, layout.totalWidth, bgH, borderRadius(fontSize));
  ctx.fill();

  // Helper: pixel-snapped hairline (1 CSS px, device-aligned)
  const m = ctx.getTransform();
  const dpr = window.devicePixelRatio || 1;
  const drawSep = (y: number) => {
    const devX = Math.round(m.a * originX + m.e);
    const devY = Math.round(m.d * y + m.f);
    const devW = Math.round(m.a * (originX + layout.totalWidth) + m.e) - devX;
    ctx.save();
    ctx.resetTransform();
    ctx.fillStyle = CODE_SEPARATOR;
    ctx.fillRect(devX, devY, devW, dpr);
    ctx.restore();
  };

  // 2. Header bar
  if (title !== undefined) {
    const sepY = originY + hh;
    drawSep(sepY);

    ctx.textBaseline = 'middle';
    // Title text
    ctx.fillStyle = CODE_TITLE_COLOR;
    ctx.font = chromeFont;
    ctx.fillText(title, originX + pl, originY + hh / 2);

    // Play button — green circle with white triangle
    const btnR = fontSize * 0.5;
    const btnCx = originX + layout.totalWidth - padRight(fontSize) - btnR;
    const btnCy = originY + hh / 2;

    ctx.fillStyle = CODE_PLAY_BG;
    ctx.beginPath();
    ctx.arc(btnCx, btnCy, btnR, 0, Math.PI * 2);
    ctx.fill();

    // Green play triangle inside
    const triH = btnR * 0.9;
    const triW = triH * 0.85;
    const triX = btnCx - triW * 0.35;
    ctx.fillStyle = CODE_PLAY_GREEN;
    ctx.beginPath();
    ctx.moveTo(triX, btnCy - triH / 2);
    ctx.lineTo(triX + triW, btnCy);
    ctx.lineTo(triX, btnCy + triH / 2);
    ctx.closePath();
    ctx.fill();
  }

  // 3. Code content — shifted down by header height
  const codeTop = originY + hh;
  ctx.textBaseline = 'alphabetic';
  const bl = baselineOffset(fontSize);
  let prevFont = '';

  for (let i = 0; i < layout.lines.length; i++) {
    const vline = layout.lines[i];
    const baseY = codeTop + pt + i * lh + bl;

    // Gutter — only on first segment of source line, when lineNumbers enabled
    if (layout.lineNumbers && vline.from === 0) {
      ctx.fillStyle = CODE_GUTTER;
      if (prevFont !== normalFont) {
        ctx.font = normalFont;
        prevFont = normalFont;
      }
      const lineNum = String(vline.srcIdx + 1);
      ctx.fillText(lineNum, originX + pl + (digits - lineNum.length) * cw, baseY);
    }

    // Code text — iterate RunSpans with inline [vFrom, vTo) clipping
    const lineSpans = spans[vline.srcIdx];
    const lineText = sourceLines[vline.srcIdx];
    if (!lineSpans || !lineText) continue;

    const vFrom = vline.from;
    const vTo = vline.from + vline.text.length;
    let x = originX + cl;

    for (let si = 0; si < lineSpans.length; si += 3) {
      const spanOff = lineSpans[si];
      const spanLen = lineSpans[si + 1];
      const style = lineSpans[si + 2];
      const spanEnd = spanOff + spanLen;

      // Skip spans entirely outside [vFrom, vTo)
      if (spanEnd <= vFrom) continue;
      if (spanOff >= vTo) break;

      // Clip to visual line range
      const drawFrom = Math.max(spanOff, vFrom);
      const drawTo = Math.min(spanEnd, vTo);
      const drawLen = drawTo - drawFrom;
      if (drawLen <= 0) continue;

      const font = isBold(style) ? boldFont : normalFont;
      if (prevFont !== font) {
        ctx.font = font;
        prevFont = font;
      }
      ctx.fillStyle = PALETTE[style];

      // Only fillText for non-whitespace
      let allWhitespace = true;
      for (let ci = drawFrom; ci < drawTo; ci++) {
        const cc = lineText.charCodeAt(ci);
        if (cc !== 32 && cc !== 9) {
          allWhitespace = false;
          break;
        }
      }
      if (!allWhitespace) {
        ctx.fillText(lineText.substring(drawFrom, drawTo), x, baseY);
      }
      x += drawLen * cw;
    }
  }

  // Placeholder — empty block shows grey hint text at first line position
  if (sourceLines.length === 1 && sourceLines[0] === '') {
    ctx.fillStyle = CODE_GUTTER;
    ctx.font = normalFont;
    ctx.fillText('Type something...', originX + cl, codeTop + pt + bl);
  }

  // 4. Output panel
  if (output !== undefined) {
    const codeBottomY = codeTop + pt + layout.lines.length * lh + padBottom(fontSize);
    drawSep(codeBottomY);

    const labelH = fontSize * OUTPUT_LABEL_H_RATIO;
    const outputLH = cfs * OUTPUT_LINE_H_MULT;

    // "Output" label
    ctx.textBaseline = 'middle';
    ctx.font = chromeFont;
    ctx.fillStyle = CODE_OUTPUT_LABEL;
    ctx.fillText('Output', originX + pl, codeBottomY + labelH / 2);

    // Output text lines
    if (output) {
      const outputLines = output.split('\n');
      const maxLines = Math.min(outputLines.length, MAX_OUTPUT_CANVAS_LINES);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = CODE_DEFAULT;
      ctx.font = chromeFont;
      const chromeBl = (cfs * (OUTPUT_LINE_H_MULT + 0.8)) / 2; // approximate ascent
      for (let i = 0; i < maxLines; i++) {
        ctx.fillText(outputLines[i], originX + pl, codeBottomY + labelH + i * outputLH + chromeBl);
      }
    }
  }

  ctx.restore();
}
