/**
 * Code System — SOA pipeline (source → spans → layout → output), worker pool, font metrics, renderer.
 *
 * Three-tier tokenization mirrors the data flow:
 *   Y.Text.toString()
 *       ↓ buildCodeSourceInto
 *   CodeSource (fullText + lineStart Uint32Array)
 *       ↓ syncTokenizeInto (sync floor) / lezer worker (ceiling)
 *   CodeSpans (flat spanData Uint16Array + spanLineStart Uint32Array)
 *       ↓ layoutCodeSourceInto
 *   CodeLayout (vlSrcIdx / vlFrom / vlLen Uint32Arrays)
 *       ↓
 *   renderCodeLayout()    canvas output
 *   computeCodeBBox()     spatial index
 *
 * All four buffers are pooled per-id on `CacheEntry`; `out?` parameters reuse buffers
 * across content edits, font/width changes, and reflow gestures. Hot paths allocate zero.
 */

import type * as Y from 'yjs';
import { invalidateWorld } from '@/renderer/RenderLoop';
import type { CodeLanguage } from '../accessors';
import { getCodeProps } from '../accessors';
import { frameTupleToWorldBounds } from '../geometry/bounds';
import { getMeasuredAscentRatio, getMeasuredDescentRatio, getMinCharWidthRatio } from '../text/text-system';
import type { BBoxTuple, FrameTuple } from '../types/geometry';

import {
  CHROME_FONT_RATIO,
  CODE_BG,
  CODE_DEFAULT,
  CODE_FONT_FAMILY,
  CODE_GUTTER,
  CODE_OUTPUT_LABEL,
  CODE_PLAY_BG,
  CODE_PLAY_GREEN,
  CODE_SEPARATOR,
  CODE_TITLE_COLOR,
  HEADER_HEIGHT_RATIO,
  isBold,
  LINE_HEIGHT_MULT,
  MAX_OUTPUT_CANVAS_LINES,
  OUTPUT_LABEL_H_RATIO,
  OUTPUT_LINE_H_MULT,
  OUTPUT_PAD_BOTTOM_RATIO,
  PALETTE,
  syncTokenizeInto,
} from './code-tokens';

// ============================================================================
// §1 TYPES — SOA pipeline
// ============================================================================

/**
 * Tier 1: source text + line offset table. `lineStart[lineCount] = fullText.length + 1`
 * sentinel so `lineLen(i) = lineStart[i+1] - lineStart[i] - 1` works for the last line.
 */
export interface CodeSource {
  fullText: string;
  lineStart: Uint32Array; // [lineCap + 1]
  lineCount: number;
  lineCap: number;
}

/**
 * Tier 2: flat span buffer. Triples [off, len, style] for line i live at
 * `spanData[spanLineStart[i] .. spanLineStart[i+1])`. `spanCap` measured in u16 slots.
 */
export interface CodeSpans {
  spanData: Uint16Array;
  spanLineStart: Uint32Array; // [lineCap + 1]
  lineCount: number;
  spanCap: number;
  lineCap: number;
}

/**
 * Tier 3: visual lines (post-wrapping). No string slots — renderer derives line text from
 * `(source.fullText, source.lineStart[srcIdx])`.
 */
export interface CodeLayout {
  fontSize: number;
  width: number;
  lineNumbers: boolean;
  totalWidth: number; // = width
  sourceLineCount: number;

  visualLineCount: number;
  visualLineCap: number;
  vlSrcIdx: Uint32Array; // [visualLineCap]
  vlFrom: Uint32Array; // [visualLineCap]  char offset within source line
  vlLen: Uint32Array; // [visualLineCap]   char length of visual line
}

/** Small cache for output panel. Rebuilt only when the `output` Y.Map field changes. */
export interface CodeOutput {
  text: string | null;
  lineStart: Uint32Array; // [lineCap + 1]
  lineCount: number;
  lineCap: number;
}

interface CacheEntry {
  source: CodeSource;
  spans: CodeSpans;
  layout: CodeLayout;
  output: CodeOutput;

  version: number;
  language: CodeLanguage;
  frame: FrameTuple | null;

  // Layout cache keys
  layoutFontSize: number;
  layoutWidth: number;
  layoutLineNumbers: boolean;
  layoutValid: boolean;
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
  spanData: Uint16Array;
  spanLineStart: Uint32Array;
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
  return MIN_CHARS * cw + padLeft(fontSize) + padRight(fontSize) + gutterWidth(2, fontSize) + gutterPad(fontSize);
}

export function getDefaultWidth(fontSize: number): number {
  const cw = charWidth(fontSize);
  return DEFAULT_CHARS * cw + padLeft(fontSize) + padRight(fontSize) + gutterWidth(2, fontSize) + gutterPad(fontSize);
}

// ============================================================================
// §4 SOURCE BUFFER — buildCodeSourceInto + capacity helpers
// ============================================================================

function createCodeSource(): CodeSource {
  return {
    fullText: '',
    lineStart: new Uint32Array(9), // cap 8 + 1 sentinel slot
    lineCount: 0,
    lineCap: 8,
  };
}

export function ensureSourceLineCap(s: CodeSource, n: number): void {
  if (s.lineCap >= n) return;
  let cap = s.lineCap;
  while (cap < n) cap *= 2;
  const next = new Uint32Array(cap + 1);
  next.set(s.lineStart);
  s.lineStart = next;
  s.lineCap = cap;
}

/**
 * Rebuild source line offsets from text. `out.fullText` aliases the text string;
 * `lineStart` slots written in-place (capacity grows but never shrinks).
 */
export function buildCodeSourceInto(text: string, out: CodeSource): void {
  out.fullText = text;
  // Count newlines for capacity sizing
  let lineCount = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineCount++;
  }
  ensureSourceLineCap(out, lineCount);
  out.lineCount = lineCount;
  out.lineStart[0] = 0;
  let li = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.lineStart[li++] = i + 1;
    }
  }
  // Sentinel: text.length + 1 so `lineLen(last) = lineStart[last+1] - lineStart[last] - 1`
  // resolves to text.length - lineStart[last].
  out.lineStart[lineCount] = text.length + 1;
}

// ============================================================================
// §4b SPANS BUFFER — capacity helpers (used by code-tokens.ts and worker swap)
// ============================================================================

function createCodeSpans(): CodeSpans {
  return {
    spanData: new Uint16Array(48), // 16 triples
    spanLineStart: new Uint32Array(9), // cap 8 + sentinel
    lineCount: 0,
    spanCap: 48,
    lineCap: 8,
  };
}

export function ensureSpansLineCap(s: CodeSpans, n: number): void {
  if (s.lineCap >= n) return;
  let cap = s.lineCap;
  while (cap < n) cap *= 2;
  const next = new Uint32Array(cap + 1);
  next.set(s.spanLineStart);
  s.spanLineStart = next;
  s.lineCap = cap;
}

export function ensureSpansDataCap(s: CodeSpans, n: number): void {
  if (s.spanCap >= n) return;
  let cap = s.spanCap;
  while (cap < n) cap *= 2;
  const next = new Uint16Array(cap);
  next.set(s.spanData);
  s.spanData = next;
  s.spanCap = cap;
}

// ============================================================================
// §5 LAYOUT — pooled SOA, in-place reflow
// ============================================================================

export function createCodeLayout(): CodeLayout {
  return {
    fontSize: 0,
    width: 0,
    lineNumbers: true,
    totalWidth: 0,
    sourceLineCount: 0,
    visualLineCount: 0,
    visualLineCap: 16,
    vlSrcIdx: new Uint32Array(16),
    vlFrom: new Uint32Array(16),
    vlLen: new Uint32Array(16),
  };
}

export function resetCodeLayout(l: CodeLayout): void {
  l.visualLineCount = 0;
}

function ensureLayoutVisualLineCap(l: CodeLayout, n: number): void {
  if (l.visualLineCap >= n) return;
  let cap = l.visualLineCap;
  while (cap < n) cap *= 2;
  const ns = new Uint32Array(cap);
  ns.set(l.vlSrcIdx);
  l.vlSrcIdx = ns;
  const nf = new Uint32Array(cap);
  nf.set(l.vlFrom);
  l.vlFrom = nf;
  const nl = new Uint32Array(cap);
  nl.set(l.vlLen);
  l.vlLen = nl;
  l.visualLineCap = cap;
}

function pushVisualLine(l: CodeLayout, srcIdx: number, from: number, len: number): void {
  ensureLayoutVisualLineCap(l, l.visualLineCount + 1);
  const v = l.visualLineCount;
  l.vlSrcIdx[v] = srcIdx;
  l.vlFrom[v] = from;
  l.vlLen[v] = len;
  l.visualLineCount = v + 1;
}

/**
 * Word-aware wrapping matching CSS break-spaces + overflow-wrap: anywhere.
 * Slot-based: `out` mutated in place, capacity preserved across calls.
 */
export function layoutCodeSourceInto(
  source: CodeSource,
  fontSize: number,
  width: number,
  lineNumbers: boolean,
  out: CodeLayout,
): CodeLayout {
  resetCodeLayout(out);
  out.fontSize = fontSize;
  out.width = width;
  out.lineNumbers = lineNumbers;
  out.totalWidth = width;
  out.sourceLineCount = source.lineCount;

  const digits = Math.max(2, String(source.lineCount).length);
  const cl = contentLeft(digits, fontSize, lineNumbers);
  const cw = charWidth(fontSize);
  const maxChars = Math.max(1, Math.floor((width - cl - padRight(fontSize)) / cw));

  const fullText = source.fullText;
  const lineStart = source.lineStart;
  const lineCount = source.lineCount;

  for (let i = 0; i < lineCount; i++) {
    const lineFrom = lineStart[i];
    const lineLen = lineStart[i + 1] - lineFrom - 1;
    if (lineLen <= maxChars) {
      pushVisualLine(out, i, 0, lineLen);
      continue;
    }
    let pos = 0;
    while (pos < lineLen) {
      if (lineLen - pos <= maxChars) {
        pushVisualLine(out, i, pos, lineLen - pos);
        break;
      }
      // Scan backward for last space/tab break opportunity within window
      let breakAt = -1;
      for (let j = pos + maxChars - 1; j >= pos; j--) {
        const c = fullText.charCodeAt(lineFrom + j);
        if (c === 32 || c === 9) {
          breakAt = j + 1;
          break;
        }
      }
      if (breakAt === -1) breakAt = pos + maxChars; // character-level fallback
      pushVisualLine(out, i, pos, breakAt - pos);
      pos = breakAt;
    }
  }

  return out;
}

/** Compute total height from layout + fontSize — not stored. */
export function totalHeight(layout: CodeLayout, fontSize: number): number {
  return padTop(fontSize) + layout.visualLineCount * lineHeight(fontSize) + padBottom(fontSize);
}

// ============================================================================
// §5b CHROME HEIGHT HELPERS — header bar + output panel
// ============================================================================

export function chromeFontSize(fs: number): number {
  return fs * CHROME_FONT_RATIO;
}

export function headerBarHeight(fs: number): number {
  return fs * HEADER_HEIGHT_RATIO;
}

function outputLineCount(output: string | undefined, cache: CodeOutput | undefined): number {
  if (!output) return 0;
  if (cache && cache.text === output) return Math.min(cache.lineCount, MAX_OUTPUT_CANVAS_LINES);
  // Allocation-free fallback: charCode scan with early exit at the cap.
  let n = 1;
  for (let i = 0; i < output.length; i++) {
    if (output.charCodeAt(i) === 10) {
      n++;
      if (n >= MAX_OUTPUT_CANVAS_LINES) return MAX_OUTPUT_CANVAS_LINES;
    }
  }
  return n;
}

export function outputPanelHeight(fs: number, output: string | undefined, cache?: CodeOutput): number {
  const cfs = chromeFontSize(fs);
  const outputLH = cfs * OUTPUT_LINE_H_MULT;
  const labelH = fs * OUTPUT_LABEL_H_RATIO;
  const padB = fs * OUTPUT_PAD_BOTTOM_RATIO;
  if (!output) return labelH + padB;
  return labelH + outputLineCount(output, cache) * outputLH + padB;
}

/** Full block height including header + code content + output panel. */
export function blockHeight(
  layout: CodeLayout,
  fontSize: number,
  headerVisible: boolean,
  outputVisible: boolean,
  output: string | undefined,
  outputCache?: CodeOutput,
): number {
  return (
    (headerVisible ? headerBarHeight(fontSize) : 0) +
    padTop(fontSize) +
    layout.visualLineCount * lineHeight(fontSize) +
    padBottom(fontSize) +
    (outputVisible ? outputPanelHeight(fontSize, output, outputCache) : 0)
  );
}

// ============================================================================
// §5c OUTPUT CACHE — pooled split avoidance
// ============================================================================

function createCodeOutput(): CodeOutput {
  return {
    text: null,
    lineStart: new Uint32Array(9),
    lineCount: 0,
    lineCap: 8,
  };
}

function ensureOutputLineCap(o: CodeOutput, n: number): void {
  if (o.lineCap >= n) return;
  let cap = o.lineCap;
  while (cap < n) cap *= 2;
  const next = new Uint32Array(cap + 1);
  next.set(o.lineStart);
  o.lineStart = next;
  o.lineCap = cap;
}

/** Identity-checked rebuild. No-op when output unchanged. */
function ensureOutputCache(entry: CacheEntry, output: string | undefined): void {
  const o = entry.output;
  const target = output ?? null;
  if (o.text === target) return;
  o.text = target;
  if (target === null) {
    o.lineCount = 0;
    o.lineStart[0] = 0;
    return;
  }
  let lineCount = 1;
  for (let i = 0; i < target.length; i++) {
    if (target.charCodeAt(i) === 10) lineCount++;
  }
  ensureOutputLineCap(o, lineCount);
  o.lineCount = lineCount;
  o.lineStart[0] = 0;
  let li = 1;
  for (let i = 0; i < target.length; i++) {
    if (target.charCodeAt(i) === 10) o.lineStart[li++] = i + 1;
  }
  o.lineStart[lineCount] = target.length + 1;
}

// ============================================================================
// §6 WORKER POOL — Warm, Persistent, Hash-Based Routing
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
  const { id, version, spanData, spanLineStart } = e.data;
  codeSystem.applyWorkerSpans(id, spanData, spanLineStart, version);
}

function requestParse(id: string, text: string, language: CodeLanguage, version: number, changes?: ChangedRange[]): void {
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
// §7 DELTA CONVERSION
// ============================================================================

/**
 * Convert Y.Text delta to ChangedRange[] for incremental Lezer parsing.
 */
export function deltaToChangedRanges(delta: { insert?: string | object; delete?: number; retain?: number }[]): ChangedRange[] {
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
    if (wi > 0 && ranges[wi - 1].toA === ranges[i].fromA && ranges[wi - 1].toB === ranges[i].fromB) {
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
// §8 CACHE
// ============================================================================

class CodeSystemCache {
  private entries = new Map<string, CacheEntry>();

  private newEntry(language: CodeLanguage): CacheEntry {
    return {
      source: createCodeSource(),
      spans: createCodeSpans(),
      layout: createCodeLayout(),
      output: createCodeOutput(),
      version: 0,
      language,
      frame: null,
      layoutFontSize: 0,
      layoutWidth: 0,
      layoutLineNumbers: true,
      layoutValid: false,
    };
  }

  getLayout(id: string, yText: Y.Text, fontSize: number, width: number, language: CodeLanguage, lineNumbers = true): CodeLayout {
    let e = this.entries.get(id);

    // COLD MISS — build full entry from Y.Text
    if (!e) {
      e = this.newEntry(language);
      const text = yText.toString();
      buildCodeSourceInto(text, e.source);
      syncTokenizeInto(e.source, language, e.spans);
      layoutCodeSourceInto(e.source, fontSize, width, lineNumbers, e.layout);
      e.version = 1;
      e.layoutFontSize = fontSize;
      e.layoutWidth = width;
      e.layoutLineNumbers = lineNumbers;
      e.layoutValid = true;
      this.entries.set(id, e);
      requestParse(id, text, language, e.version);
      return e.layout;
    }

    // Language changed — re-tokenize spans only, keep layout if dims unchanged
    if (e.language !== language) {
      syncTokenizeInto(e.source, language, e.spans);
      e.language = language;
      e.version++;
      requestParse(id, e.source.fullText, language, e.version);
      // Only recompute layout if fontSize/width/lineNumbers also changed
      if (!e.layoutValid || e.layoutFontSize !== fontSize || e.layoutWidth !== width || e.layoutLineNumbers !== lineNumbers) {
        layoutCodeSourceInto(e.source, fontSize, width, lineNumbers, e.layout);
        e.layoutFontSize = fontSize;
        e.layoutWidth = width;
        e.layoutLineNumbers = lineNumbers;
        e.layoutValid = true;
        e.frame = null;
      }
      return e.layout;
    }

    // Cached layout still valid?
    if (e.layoutValid && e.layoutFontSize === fontSize && e.layoutWidth === width && e.layoutLineNumbers === lineNumbers) {
      return e.layout;
    }

    // Relayout needed (fontSize, width, or lineNumbers changed). Slot-reuse via in-place reflow.
    layoutCodeSourceInto(e.source, fontSize, width, lineNumbers, e.layout);
    e.layoutFontSize = fontSize;
    e.layoutWidth = width;
    e.layoutLineNumbers = lineNumbers;
    e.layoutValid = true;
    e.frame = null;
    return e.layout;
  }

  /**
   * Called synchronously from deep observer on Y.Text change.
   * Runs sync tokenizer → dispatches to Lezer worker.
   */
  handleContentChange(id: string, ev: Y.YTextEvent, language: CodeLanguage): void {
    const yText = ev.target as Y.Text;
    const text = yText.toString();

    let e = this.entries.get(id);
    if (!e) {
      e = this.newEntry(language);
      this.entries.set(id, e);
    }

    buildCodeSourceInto(text, e.source);
    syncTokenizeInto(e.source, language, e.spans);
    e.version++;
    e.layoutValid = false;
    e.frame = null;

    const changes = deltaToChangedRanges(ev.delta as { insert?: string | object; delete?: number; retain?: number }[]);
    requestParse(id, text, language, e.version, changes.length > 0 ? changes : undefined);
  }

  /**
   * Apply Lezer worker spans (ceiling upgrade). Version-gated to discard stale results.
   * Swaps the spans buffers directly — zero-copy from the worker's transferred ArrayBuffers.
   */
  applyWorkerSpans(id: string, spanData: Uint16Array, spanLineStart: Uint32Array, forVersion: number): void {
    const e = this.entries.get(id);
    if (!e || forVersion !== e.version) return;
    e.spans.spanData = spanData;
    e.spans.spanCap = spanData.length;
    e.spans.spanLineStart = spanLineStart;
    e.spans.lineCap = spanLineStart.length - 1;
    e.spans.lineCount = spanLineStart.length - 1;
    // Layout dimensions unchanged — only colors differ. No layout invalidation.
    if (e.frame) {
      invalidateWorld(frameTupleToWorldBounds(e.frame));
    }
  }

  getSpans(id: string): CodeSpans | null {
    return this.entries.get(id)?.spans ?? null;
  }

  getSource(id: string): CodeSource | null {
    return this.entries.get(id)?.source ?? null;
  }

  getOutputCache(id: string, output: string | undefined): CodeOutput | null {
    const e = this.entries.get(id);
    if (!e) return null;
    ensureOutputCache(e, output);
    return e.output;
  }

  setFrame(id: string, frame: FrameTuple): void {
    const e = this.entries.get(id);
    if (e) e.frame = frame;
  }

  getFrame(id: string): FrameTuple | null {
    return this.entries.get(id)?.frame ?? null;
  }

  evict(id: string): void {
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
// §9 PUBLIC API
// ============================================================================

/** Get derived frame for a code object. Mirrors getTextFrame() pattern. */
export function getCodeFrame(id: string): FrameTuple | null {
  return codeSystem.getFrame(id);
}

/** Source-buffer accessor for transform freeze (E/W reflow gestures). */
export function getCodeSource(id: string): CodeSource | null {
  return codeSystem.getSource(id);
}

/** Compute bbox for a code object — frame→bbox conversion. */
export function computeCodeBBox(id: string, yObj: Y.Map<unknown>): BBoxTuple {
  const props = getCodeProps(yObj);
  if (!props) {
    const origin = (yObj.get('origin') as [number, number]) ?? [0, 0];
    return [origin[0], origin[1], origin[0] + 1, origin[1] + 1];
  }
  const layout = codeSystem.getLayout(id, props.content, props.fontSize, props.width, props.language, props.lineNumbers);
  const outputCache = codeSystem.getOutputCache(id, props.output) ?? undefined;
  const [ox, oy] = props.origin;
  const bh = blockHeight(layout, props.fontSize, props.headerVisible, props.outputVisible, props.output, outputCache);
  const frame: FrameTuple = [ox, oy, layout.totalWidth, bh];
  codeSystem.setFrame(id, frame);
  return [ox, oy, ox + layout.totalWidth, oy + bh];
}

// ============================================================================
// §10 CANVAS RENDERER — SOA span iteration, zero per-line allocation
// ============================================================================

/**
 * Render a code layout onto the canvas using flat CodeSpans triples + CodeSource line offsets.
 * Per-span fillText substring is the only unavoidable allocation (V8 SlicedString).
 */
export function renderCodeLayout(
  ctx: CanvasRenderingContext2D,
  layout: CodeLayout,
  originX: number,
  originY: number,
  fontSize: number,
  spans: CodeSpans,
  source: CodeSource,
  title?: string,
  output?: string,
  outputCache?: CodeOutput,
): void {
  const lh = lineHeight(fontSize);
  const cw = charWidth(fontSize);
  const pt = padTop(fontSize);
  const pl = padLeft(fontSize);
  const hh = title !== undefined ? headerBarHeight(fontSize) : 0;
  const bgH = blockHeight(layout, fontSize, title !== undefined, output !== undefined, output, outputCache);
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

  const fullText = source.fullText;
  const sourceLineStart = source.lineStart;
  const spanData = spans.spanData;
  const spanLineStart = spans.spanLineStart;
  const visualLineCount = layout.visualLineCount;
  const vlSrcIdx = layout.vlSrcIdx;
  const vlFrom = layout.vlFrom;
  const vlLen = layout.vlLen;

  for (let i = 0; i < visualLineCount; i++) {
    const srcIdx = vlSrcIdx[i];
    const vFrom = vlFrom[i];
    const vTo = vFrom + vlLen[i];
    const baseY = codeTop + pt + i * lh + bl;

    // Gutter — only on first segment of source line, when lineNumbers enabled
    if (layout.lineNumbers && vFrom === 0) {
      ctx.fillStyle = CODE_GUTTER;
      if (prevFont !== normalFont) {
        ctx.font = normalFont;
        prevFont = normalFont;
      }
      const lineNum = String(srcIdx + 1);
      ctx.fillText(lineNum, originX + pl + (digits - lineNum.length) * cw, baseY);
    }

    // Code text — iterate flat spans for this source line with [vFrom, vTo) clipping
    const spanFrom = spanLineStart[srcIdx];
    const spanTo = spanLineStart[srcIdx + 1];
    if (spanFrom === spanTo) continue;

    const lineStartChar = sourceLineStart[srcIdx];
    let x = originX + cl;

    for (let si = spanFrom; si < spanTo; si += 3) {
      const spanOff = spanData[si];
      const spanLen = spanData[si + 1];
      const style = spanData[si + 2];
      const spanEnd = spanOff + spanLen;

      // Skip spans entirely outside [vFrom, vTo)
      if (spanEnd <= vFrom) continue;
      if (spanOff >= vTo) break;

      // Clip to visual line range
      const drawFrom = spanOff > vFrom ? spanOff : vFrom;
      const drawTo = spanEnd < vTo ? spanEnd : vTo;
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
      const absFrom = lineStartChar + drawFrom;
      const absTo = lineStartChar + drawTo;
      for (let ci = absFrom; ci < absTo; ci++) {
        const cc = fullText.charCodeAt(ci);
        if (cc !== 32 && cc !== 9) {
          allWhitespace = false;
          break;
        }
      }
      if (!allWhitespace) {
        ctx.fillText(fullText.substring(absFrom, absTo), x, baseY);
      }
      x += drawLen * cw;
    }
  }

  // Placeholder — empty block shows grey hint text at first line position
  if (source.lineCount === 1 && source.fullText.length === 0) {
    ctx.fillStyle = CODE_GUTTER;
    ctx.font = normalFont;
    ctx.fillText('Type something...', originX + cl, codeTop + pt + bl);
  }

  // 4. Output panel
  if (output !== undefined) {
    const codeBottomY = codeTop + pt + visualLineCount * lh + padBottom(fontSize);
    drawSep(codeBottomY);

    const labelH = fontSize * OUTPUT_LABEL_H_RATIO;
    const outputLH = cfs * OUTPUT_LINE_H_MULT;

    // "Output" label
    ctx.textBaseline = 'middle';
    ctx.font = chromeFont;
    ctx.fillStyle = CODE_OUTPUT_LABEL;
    ctx.fillText('Output', originX + pl, codeBottomY + labelH / 2);

    // Output text lines — iterate via cached lineStart when available
    if (output) {
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = CODE_DEFAULT;
      ctx.font = chromeFont;
      const chromeBl = (cfs * (OUTPUT_LINE_H_MULT + 0.8)) / 2; // approximate ascent
      if (outputCache && outputCache.text === output) {
        const maxLines = Math.min(outputCache.lineCount, MAX_OUTPUT_CANVAS_LINES);
        const ls = outputCache.lineStart;
        for (let i = 0; i < maxLines; i++) {
          const from = ls[i];
          const to = ls[i + 1] - 1;
          ctx.fillText(output.substring(from, to), originX + pl, codeBottomY + labelH + i * outputLH + chromeBl);
        }
      } else {
        // First-paint path with no cache — walk the string directly without splitting.
        let from = 0;
        let i = 0;
        while (i < MAX_OUTPUT_CANVAS_LINES) {
          let to = output.indexOf('\n', from);
          if (to === -1) to = output.length;
          ctx.fillText(output.substring(from, to), originX + pl, codeBottomY + labelH + i * outputLH + chromeBl);
          if (to === output.length) break;
          from = to + 1;
          i++;
        }
      }
    }
  }

  ctx.restore();
}
