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
import { invalidateWorldBBox } from '@/renderer/RenderLoop';
import { getVisibleBoundsTuple } from '@/stores/camera-store';
import type { CodeLanguage } from '../accessors';
import { getCodeProps } from '../accessors';
import { assertCrossOriginIsolated } from '../sab';
import { getMeasuredAscentRatio, getMeasuredDescentRatio, getMinCharWidthRatio } from '../text/text-measure';
import type { BBoxTuple, FrameTuple } from '../types/geometry';
import { syncTokenizeInto } from './code-tokenizer';
import {
  CHROME_FONT_RATIO,
  CODE_FONT_FAMILY,
  ensureSpansDataCap,
  ensureSpansLineCap,
  HEADER_HEIGHT_RATIO,
  LINE_HEIGHT_MULT,
  MAX_OUTPUT_CANVAS_LINES,
  OUTPUT_LABEL_H_RATIO,
  OUTPUT_LINE_H_MULT,
  OUTPUT_PAD_BOTTOM_RATIO,
  playButtonGeom,
  S,
  SAB_H_LINE_CAP,
  SAB_H_LINE_COUNT,
  SAB_H_VERSION,
  SAB_HDR_BYTES,
  THEME,
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
 *
 * Whitespace runs are sentinelled to `S.WHITESPACE` in the style slot at
 * tokenize time, so the renderer skips ink work via a single `style === S.WHITESPACE`
 * compare — no parallel buffer, no `(si/3)|0` divide, no second cache line.
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
 * `(source.fullText, source.lineStart[srcIdx])`. `normalFont`/`chromeFont` are cached at
 * layout time so the renderer doesn't allocate template strings per call.
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

  // Cached font strings — recomputed by `layoutCodeSourceInto` only when fontSize changes.
  normalFont: string;
  chromeFont: string;

  // Cached pixel metrics — the `fs * ratio` products + measured-ratio Map lookups
  // that used to be recomputed every frame per block. Populated each
  // `layoutCodeSourceInto` call (self-healing across font load); read by
  // `renderCodeLayout` / `blockHeight` / `computeCodeBBoxInto`. Stable order,
  // init 0 in `createCodeLayout` so V8 keeps one hidden class (the transform
  // reflow buffer shares the factory).
  charWidthPx: number;
  baselineOffsetPx: number;
  contentLeftPx: number;
  lineHeightPx: number;
  padTopPx: number;
  padBottomPx: number;
  padLeftPx: number;
  padRightPx: number;
  chromeFontSizePx: number;
  headerBarHeightPx: number;
  borderRadiusPx: number;
  gutterDigits: number;
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

  // Guards the cold full-text seed to the worker: an `edits` (delta) message
  // must never precede the first full seed, whatever the observer/Yjs ordering.
  seeded: boolean;

  // Worker-parse gating — at most ONE parse in flight per block. Edits during
  // flight batch into `pending` (flushed as one message on doorbell receipt);
  // a language change mid-flight queues a full reseed instead, which subsumes
  // any batched deltas. This is also what serializes worker-SAB writes against
  // the doorbell handler's copy (single-buffer safety).
  inFlight: boolean;
  pending: DeltaOp[][]; // delta batches, in edit order (array reused via length=0)
  pendingSeed: boolean;

  // Layout cache keys
  layoutFontSize: number;
  layoutWidth: number;
  layoutLineNumbers: boolean;
  layoutValid: boolean;
}

/** Yjs Y.Text delta op — referenced (not copied) straight into the edits message. */
type DeltaOp = { retain?: number; insert?: string | object; delete?: number };

type WorkerRequest =
  | { type: 'parse'; id: string; language: CodeLanguage; version: number; text: string } // full seed/reset
  | { type: 'parse'; id: string; language: CodeLanguage; version: number; edits: DeltaOp[][] } // Yjs delta batches
  | { type: 'remove'; id: string }
  | { type: 'clearAll' };

type WorkerResponse =
  | { type: 'spans'; id: string; sab: SharedArrayBuffer } // doorbell — payload lives in the SAB
  | { type: 'parse-failed'; id: string }; // gate-release on worker crash/desync

// ============================================================================
// §2 CONSTANTS
// ============================================================================

export const DEFAULT_FONT_SIZE = 14;
export const MIN_CHARS = 20;
export const DEFAULT_CHARS = 50;

export const FONT_WEIGHT = 450;
export const CODE_FONT = `'${CODE_FONT_FAMILY}', monospace`;

const PAD_TOP_RATIO = 1.5;
const PAD_BOTTOM_RATIO = 1.5;
const PAD_LEFT_RATIO = 1.0;
const PAD_RIGHT_RATIO = 0.85;
const GUTTER_GAP_RATIO = 0.5;
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
export function gutterGap(fs: number): number {
  return fs * GUTTER_GAP_RATIO;
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
  const pl = padLeft(fontSize);
  if (!lineNumbers) return pl;
  return pl + gutterWidth(maxDigits, fontSize) + gutterGap(fontSize) + pl;
}

export function getMinWidth(fontSize: number): number {
  return MIN_CHARS * charWidth(fontSize) + contentLeft(2, fontSize, true) + padRight(fontSize);
}

export function getDefaultWidth(fontSize: number): number {
  return DEFAULT_CHARS * charWidth(fontSize) + contentLeft(2, fontSize, true) + padRight(fontSize);
}

/** Allocation-free decimal-digit count for a positive line count (replaces `String(n).length`). */
function digitCount(n: number): number {
  if (n < 10) return 1;
  if (n < 100) return 2;
  if (n < 1000) return 3;
  if (n < 10000) return 4;
  return (Math.log10(n) | 0) + 1;
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
// §4b SPANS BUFFER — `CodeSpans` factory. Capacity helpers (`ensureSpansDataCap`,
// `ensureSpansLineCap`) live in `code-tokens.ts` so the lezer worker's import
// graph never reaches `code-system.ts` (which would drag in RenderLoop →
// image-manager and crash the worker on load).
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
    normalFont: '',
    chromeFont: '',
    charWidthPx: 0,
    baselineOffsetPx: 0,
    contentLeftPx: 0,
    lineHeightPx: 0,
    padTopPx: 0,
    padBottomPx: 0,
    padLeftPx: 0,
    padRightPx: 0,
    chromeFontSizePx: 0,
    headerBarHeightPx: 0,
    borderRadiusPx: 0,
    gutterDigits: 0,
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
  // Recompute cached font strings only when fontSize changes — string template is
  // hot enough at 60fps that even a tiny `${weight} ${px}px` allocation matters.
  if (out.fontSize !== fontSize) {
    out.normalFont = `${FONT_WEIGHT} ${fontSize}px ${CODE_FONT}`;
    out.chromeFont = `${FONT_WEIGHT} ${chromeFontSize(fontSize)}px ${CODE_FONT}`;
  }
  out.fontSize = fontSize;
  out.width = width;
  out.lineNumbers = lineNumbers;
  out.totalWidth = width;
  out.sourceLineCount = source.lineCount;

  const digits = Math.max(2, digitCount(source.lineCount));
  const cl = contentLeft(digits, fontSize, lineNumbers);
  const cw = charWidth(fontSize);
  const pr = padRight(fontSize);
  const maxChars = Math.max(1, Math.floor((width - cl - pr) / cw));

  // Cache pixel metrics for the render hot path (also read by blockHeight +
  // computeCodeBBoxInto). Computed EVERY call (not gated on fontSize) so it
  // self-heals across the font-load boundary — charWidthPx / baselineOffsetPx
  // depend on measured font ratios that fall back before fonts load. Safe
  // because main.tsx awaits ensureFontsLoaded() + resetFontMetrics() BEFORE the
  // canvas mounts (every layout is post-font-load); computing each call makes it
  // self-healing even if that ordering ever changed. `cw`/`cl` reuse the products
  // above. (`normalFont`/`chromeFont` keep their own fontSize gate below.)
  out.charWidthPx = cw;
  out.baselineOffsetPx = baselineOffset(fontSize);
  out.contentLeftPx = cl;
  out.lineHeightPx = lineHeight(fontSize);
  out.padTopPx = padTop(fontSize);
  out.padBottomPx = padBottom(fontSize);
  out.padLeftPx = padLeft(fontSize);
  out.padRightPx = pr;
  out.chromeFontSizePx = chromeFontSize(fontSize);
  out.headerBarHeightPx = headerBarHeight(fontSize);
  out.borderRadiusPx = borderRadius(fontSize);
  out.gutterDigits = digits;

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

/**
 * Full block height including header + code content + output panel. Reads the
 * cached px metrics off `layout` — no `fontSize` param (redundant with
 * `layout.fontSize`). The output-panel branch inlines `outputPanelHeight`'s math
 * (that function keeps its `fs` signature for external callers) using the cached
 * `chromeFontSizePx`.
 */
export function blockHeight(
  layout: CodeLayout,
  headerVisible: boolean,
  outputVisible: boolean,
  output: string | undefined,
  outputCache?: CodeOutput,
): number {
  let h =
    (headerVisible ? layout.headerBarHeightPx : 0) + layout.padTopPx + layout.visualLineCount * layout.lineHeightPx + layout.padBottomPx;
  if (outputVisible) {
    const labelH = layout.fontSize * OUTPUT_LABEL_H_RATIO;
    const padB = layout.fontSize * OUTPUT_PAD_BOTTOM_RATIO;
    h += output ? labelH + outputLineCount(output, outputCache) * (layout.chromeFontSizePx * OUTPUT_LINE_H_MULT) + padB : labelH + padB;
  }
  return h;
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
// §6 WORKER POOL — Warm, Persistent, Least-Loaded Seed Routing (sticky pins)
// ============================================================================

const POOL_SIZE = 2;
const workers: Worker[] = [];
let workersReady = false;

// An id pins to one worker at seed time (its incremental Tree + fragments +
// text mirror live there) — chosen by lowest outstanding-parse count so
// hydrate bursts / multi-block pastes split across the pool instead of
// skewing on an id hash. Counters are a balancing heuristic only: inc on
// parse post, dec on any doorbell (floored), settled on evict-mid-flight.
const _pinned = new Map<string, number>();
const _outstanding: number[] = new Array(POOL_SIZE).fill(0);

function settleOutstanding(id: string): void {
  const w = _pinned.get(id);
  if (w !== undefined && _outstanding[w] > 0) _outstanding[w]--;
}

function ensureWorkers(): void {
  if (workersReady) return;
  assertCrossOriginIsolated(); // spans travel via SharedArrayBuffer
  workersReady = true;
  for (let i = 0; i < POOL_SIZE; i++) {
    const w = new Worker(new URL('./lezer-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = handleWorkerMessage;
    w.onerror = (e) => console.error('[worker] onerror', i, e.message, e.filename, e.lineno);
    w.onmessageerror = (e) => console.error('[worker] onmessageerror', i, e);
    workers.push(w);
  }
}

function dispatch(msg: WorkerRequest): void {
  ensureWorkers();
  if (msg.type === 'clearAll') {
    // Broadcast to ALL workers (fixes bug where only one got cleared)
    for (const w of workers) w.postMessage(msg);
    _pinned.clear();
    _outstanding.fill(0);
    return;
  }
  if (msg.type === 'remove') {
    const w = _pinned.get(msg.id);
    if (w !== undefined) {
      workers[w].postMessage(msg);
      _pinned.delete(msg.id);
    }
    return; // never pinned ⇒ no worker ever saw the id — nothing to remove
  }
  // parse — pin on first dispatch (seed), sticky thereafter.
  let w = _pinned.get(msg.id);
  if (w === undefined) {
    w = 0;
    for (let i = 1; i < POOL_SIZE; i++) if (_outstanding[i] < _outstanding[w]) w = i;
    _pinned.set(msg.id, w);
  }
  _outstanding[w]++;
  workers[w].postMessage(msg);
}

function handleWorkerMessage(e: MessageEvent<WorkerResponse>): void {
  const msg = e.data;
  settleOutstanding(msg.id);
  if (msg.type === 'spans') codeSystem.applyWorkerSpans(msg.id, msg.sab);
  else codeSystem.onParseFailed(msg.id);
}

// Pooled message wrappers — one per parse form. postMessage structured-clones
// synchronously during the `dispatch` call, so reusing a single object across
// calls is safe. `edits` just references `ev.delta` (Yjs already allocated it).
const _fullMsg: { type: 'parse'; id: string; language: CodeLanguage; version: number; text: string } = {
  type: 'parse',
  id: '',
  language: 'javascript',
  version: 0,
  text: '',
};
const _editsMsg: { type: 'parse'; id: string; language: CodeLanguage; version: number; edits: DeltaOp[][] } = {
  type: 'parse',
  id: '',
  language: 'javascript',
  version: 0,
  edits: [],
};

// Pooled single-batch wrapper for the not-in-flight fast path (one delta per
// message). Safe to reuse: dispatch structured-clones synchronously.
const _singleBatch: DeltaOp[][] = [[]];

/** Full-text seed/reset — cold miss + language change (worker resets its mirror). */
function requestParse(id: string, text: string, language: CodeLanguage, version: number): void {
  _fullMsg.id = id;
  _fullMsg.language = language;
  _fullMsg.version = version;
  _fullMsg.text = text;
  dispatch(_fullMsg);
}

/** Incremental edits — posts Yjs delta batches; the worker splices its mirror per batch + parses once. */
function requestParseEdits(id: string, language: CodeLanguage, version: number, edits: DeltaOp[][]): void {
  _editsMsg.id = id;
  _editsMsg.language = language;
  _editsMsg.version = version;
  _editsMsg.edits = edits;
  dispatch(_editsMsg);
}

function requestRemove(id: string): void {
  if (!workersReady) return;
  dispatch({ type: 'remove', id });
}

function requestClearAll(): void {
  if (!workersReady) return;
  dispatch({ type: 'clearAll' });
}

/**
 * Terminate the warm worker pool — room teardown only (NOT hydrate, which also clears caches).
 * Workers re-create lazily via ensureWorkers() on the next parse. No-op if never spun up.
 */
export function terminateCodeWorkers(): void {
  if (!workersReady) return;
  for (const w of workers) w.terminate();
  workers.length = 0;
  workersReady = false;
  _pinned.clear();
  _outstanding.fill(0);
}

// ============================================================================
// §7 CACHE
// ============================================================================

// Globally monotonic parse version — never reused across entry incarnations,
// so a stale doorbell can never falsely match a re-created entry (evict +
// undo-recreate, clearAll + rehydrate) whose per-entry counter would restart.
let _nextVersion = 0;

// Scratch for the doorbell's viewport-culled dirty rect — no per-response literal.
const _invalidateScratch: BBoxTuple = [0, 0, 0, 0];

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
      seeded: false,
      inFlight: false,
      pending: [],
      pendingSeed: false,
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
      e.version = ++_nextVersion;
      e.layoutFontSize = fontSize;
      e.layoutWidth = width;
      e.layoutLineNumbers = lineNumbers;
      e.layoutValid = true;
      this.entries.set(id, e);
      requestParse(id, text, language, e.version);
      e.seeded = true;
      e.inFlight = true;
      return e.layout;
    }

    // Language changed — re-tokenize spans only, keep layout if dims unchanged.
    // Full seed resets the worker's mirror to the current text; `seeded` stays true.
    if (e.language !== language) {
      syncTokenizeInto(e.source, language, e.spans);
      e.language = language;
      e.version = ++_nextVersion;
      if (e.inFlight) {
        // Reseed at flush time — the full text subsumes any batched deltas.
        e.pendingSeed = true;
        e.pending.length = 0;
      } else {
        requestParse(id, e.source.fullText, language, e.version);
        e.inFlight = true;
      }
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
    e.version = ++_nextVersion;
    e.layoutValid = false;
    e.frame = null;

    // First edit to an unseeded entry sends the full text (seeds the worker
    // mirror); after that only Yjs deltas cross the thread boundary. The
    // in-flight gate keeps at most one parse outstanding: deltas that land
    // during a flight batch into `pending` and flush as ONE message when the
    // doorbell arrives — an N-keystroke burst costs N mirror splices + 1 parse
    // on the worker instead of N parses. A queued reseed subsumes deltas.
    if (!e.seeded) {
      requestParse(id, text, language, e.version);
      e.seeded = true;
      e.inFlight = true;
    } else if (!e.inFlight) {
      _singleBatch[0] = ev.delta as DeltaOp[];
      requestParseEdits(id, language, e.version, _singleBatch);
      e.inFlight = true;
    } else if (!e.pendingSeed) {
      e.pending.push(ev.delta as DeltaOp[]);
    }
  }

  /**
   * Spans doorbell (ceiling upgrade). The payload lives in the block's SAB;
   * this acquire-loads the published version, gates it against `e.version`
   * (strict equality — stale publishes are never read), copies into the
   * pooled `e.spans` buffers, then flushes any batched edits. ORDER IS
   * LOAD-BEARING: the flush post must come AFTER the copy — the worker starts
   * overwriting the (single-buffer) SAB the moment the next parse message
   * lands.
   */
  applyWorkerSpans(id: string, sab: SharedArrayBuffer): void {
    const e = this.entries.get(id);
    if (!e) return; // evicted mid-flight — worker cleanup rode the 'remove'
    const hdr = new Int32Array(sab, 0, 8);
    const ver = Atomics.load(hdr, SAB_H_VERSION); // acquire — covers the plain writes
    if (ver === e.version) {
      const lineCap = hdr[SAB_H_LINE_CAP];
      const lineCount = hdr[SAB_H_LINE_COUNT];
      const ls = new Uint32Array(sab, SAB_HDR_BYTES, lineCap + 1);
      const used = ls[lineCount];
      const sp = new Uint16Array(sab, SAB_HDR_BYTES + (lineCap + 1) * 4, used);
      const s = e.spans;
      ensureSpansLineCap(s, lineCount);
      ensureSpansDataCap(s, used);
      s.spanLineStart.set(ls.subarray(0, lineCount + 1));
      s.spanData.set(sp);
      s.lineCount = lineCount;
      if (import.meta.env.DEV && Atomics.load(hdr, SAB_H_VERSION) !== ver) {
        console.error('[code] spans SAB overwritten during copy — gating broken', id);
      }
      // Layout dimensions unchanged — only colors differ. No layout invalidation.
      // Viewport-cull: a code block edited remotely while it's fully off-screen
      // doesn't need to mark a dirty rect — the next pan/zoom into view will
      // repaint it from scratch anyway.
      if (e.frame) {
        const [fx, fy, fw, fh] = e.frame;
        const bx1 = fx + fw;
        const by1 = fy + fh;
        const vis = getVisibleBoundsTuple();
        if (bx1 >= vis[0] && fx <= vis[2] && by1 >= vis[1] && fy <= vis[3]) {
          _invalidateScratch[0] = fx;
          _invalidateScratch[1] = fy;
          _invalidateScratch[2] = bx1;
          _invalidateScratch[3] = by1;
          invalidateWorldBBox(_invalidateScratch);
        }
      }
    }
    this.flushPending(e, id);
  }

  /** Gate-release for a parse that will never publish. `seeded=false` forces the
   *  next edit to full-seed, which also heals a possibly-desynced worker mirror. */
  onParseFailed(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.inFlight = false;
    e.pending.length = 0;
    e.pendingSeed = false;
    e.seeded = false;
  }

  /** Doorbell tail — post the queued work (reseed subsumes batches) or release the gate. */
  private flushPending(e: CacheEntry, id: string): void {
    if (e.pendingSeed) {
      e.pendingSeed = false;
      e.pending.length = 0;
      requestParse(id, e.source.fullText, e.language, e.version);
    } else if (e.pending.length > 0) {
      requestParseEdits(id, e.language, e.version, e.pending);
      e.pending.length = 0; // safe — dispatch structured-clones synchronously
    } else {
      e.inFlight = false;
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

  /**
   * In-place frame writer for the observer hot path — mutates the 4 slots of the
   * pooled `e.frame` (allocs once if null). Safe because every `frameOf`/`getCodeFrame`
   * consumer clones before retaining (connector-topology, transform) or reads
   * transiently within one synchronous pass; no `===` identity check on frames
   * exists anywhere.
   */
  setFrameXYWH(id: string, x: number, y: number, w: number, h: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    const f = e.frame;
    if (f) {
      f[0] = x;
      f[1] = y;
      f[2] = w;
      f[3] = h;
    } else {
      e.frame = [x, y, w, h];
    }
  }

  getFrame(id: string): FrameTuple | null {
    return this.entries.get(id)?.frame ?? null;
  }

  /**
   * Pure cache read for the renderer hot path. Returns the layout when an entry
   * exists AND its layout is valid (post-bbox-compute or post-handleContentChange
   * + reflow), else null. Observer pipeline guarantees validity for any handle
   * that lives in `objectsById`.
   */
  getLayoutById(id: string): CodeLayout | null {
    const e = this.entries.get(id);
    return e?.layoutValid ? e.layout : null;
  }

  evict(id: string): void {
    const e = this.entries.get(id);
    if (e?.inFlight) settleOutstanding(id); // the doorbell that would settle it gets dropped
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

/** Spans-buffer accessor mirror of getCodeSource. Used by the renderer hot path. */
export function getCodeSpans(id: string): CodeSpans | null {
  return codeSystem.getSpans(id);
}

/**
 * Compute bbox for a code object into a pooled `out` — observer hot path. Reuses
 * the cached `e.frame` in place (`setFrameXYWH`), so the observer fire allocates
 * zero (was a `FrameTuple` + a `BBoxTuple` per fire).
 */
export function computeCodeBBoxInto(id: string, yObj: Y.Map<unknown>, out: BBoxTuple): void {
  const props = getCodeProps(yObj);
  if (!props) {
    const origin = (yObj.get('origin') as [number, number]) ?? [0, 0];
    out[0] = origin[0];
    out[1] = origin[1];
    out[2] = origin[0] + 1;
    out[3] = origin[1] + 1;
    return;
  }
  const layout = codeSystem.getLayout(id, props.content, props.fontSize, props.width, props.language, props.lineNumbers);
  const outputCache = codeSystem.getOutputCache(id, props.output) ?? undefined;
  const [ox, oy] = props.origin;
  const w = layout.totalWidth;
  const bh = blockHeight(layout, props.headerVisible, props.outputVisible, props.output, outputCache);
  codeSystem.setFrameXYWH(id, ox, oy, w, bh);
  out[0] = ox;
  out[1] = oy;
  out[2] = ox + w;
  out[3] = oy + bh;
}

/** Cold-path wrapper: allocates a fresh bbox tuple. Hot paths call `computeCodeBBoxInto`. */
export function computeCodeBBox(id: string, yObj: Y.Map<unknown>): BBoxTuple {
  const out: BBoxTuple = [0, 0, 0, 0];
  computeCodeBBoxInto(id, yObj, out);
  return out;
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
  spans: CodeSpans,
  source: CodeSource,
  title?: string,
  output?: string,
  outputCache?: CodeOutput,
): void {
  // All px metrics are cached on the layout (populated by layoutCodeSourceInto).
  // No fontSize param — fontSize === layout.fontSize at every call site.
  const lh = layout.lineHeightPx;
  const cw = layout.charWidthPx;
  const pt = layout.padTopPx;
  const pl = layout.padLeftPx;
  const hh = title !== undefined ? layout.headerBarHeightPx : 0;
  const bgH = blockHeight(layout, title !== undefined, output !== undefined, output, outputCache);
  const digits = layout.gutterDigits;
  const cl = layout.contentLeftPx;
  const { normalFont, chromeFont } = layout;
  const cfs = layout.chromeFontSizePx;

  // Hoist THEME reads out of the visual-line loop (idiomatic here — the function
  // already hoists spanData / vlFrom / normalFont).
  const palette = THEME.palette;
  const gutterColor = THEME.chrome.gutter;

  ctx.save();

  // 1. Background
  ctx.fillStyle = THEME.chrome.bg;
  ctx.beginPath();
  ctx.roundRect(originX, originY, layout.totalWidth, bgH, layout.borderRadiusPx);
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
    ctx.fillStyle = THEME.chrome.sep;
    ctx.fillRect(devX, devY, devW, dpr);
    ctx.restore();
  };

  // 2. Header bar
  if (title !== undefined) {
    const sepY = originY + hh;
    drawSep(sepY);

    ctx.textBaseline = 'middle';
    // Title text
    ctx.fillStyle = THEME.chrome.title;
    ctx.font = chromeFont;
    ctx.fillText(title, originX + pl, originY + hh / 2);

    // Play button — green circle with white triangle (centroid-centered)
    const { btnR, triW, triH, triXOffset } = playButtonGeom(layout.fontSize);
    const btnCx = originX + layout.totalWidth - layout.padRightPx - btnR;
    const btnCy = originY + hh / 2;

    ctx.fillStyle = THEME.chrome.playBg;
    ctx.beginPath();
    ctx.arc(btnCx, btnCy, btnR, 0, Math.PI * 2);
    ctx.fill();

    const triX = btnCx - triXOffset;
    ctx.fillStyle = THEME.chrome.playGreen;
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
  const bl = layout.baselineOffsetPx;
  // Hoist normalFont out of the inner loop — Sweet Dracula has no bold tokens,
  // so the per-span branch that used to switch between bold/normal is gone.
  // Chrome blocks (header above, output below) set chromeFont explicitly.
  ctx.font = normalFont;

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
      ctx.fillStyle = gutterColor;
      const lineNum = String(srcIdx + 1); // needed for fillText — kept
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

      // Whitespace sentinel — single compare on a value already in a register.
      // Skip ink work AND fillText entirely.
      if (style === S.WHITESPACE) {
        x += drawLen * cw;
        continue;
      }

      ctx.fillStyle = palette[style];

      const absFrom = lineStartChar + drawFrom;
      const absTo = lineStartChar + drawTo;
      ctx.fillText(fullText.substring(absFrom, absTo), x, baseY);
      x += drawLen * cw;
    }
  }

  // Placeholder — empty block shows grey hint text at first line position.
  // ctx.font is still normalFont from the hoist above.
  if (source.lineCount === 1 && source.fullText.length === 0) {
    ctx.fillStyle = gutterColor;
    ctx.fillText('Type something...', originX + cl, codeTop + pt + bl);
  }

  // 4. Output panel
  if (output !== undefined) {
    const codeBottomY = codeTop + pt + visualLineCount * lh + layout.padBottomPx;
    drawSep(codeBottomY);

    const labelH = layout.fontSize * OUTPUT_LABEL_H_RATIO;
    const outputLH = cfs * OUTPUT_LINE_H_MULT;

    // "Output" label
    ctx.textBaseline = 'middle';
    ctx.font = chromeFont;
    ctx.fillStyle = THEME.chrome.outputLabel;
    ctx.fillText('Output', originX + pl, codeBottomY + labelH / 2);

    // Output text lines — outputCache is eagerly built by callers (objects.ts +
    // computeCodeBBox), so the cache is always populated and identity-matched
    // when output is non-empty. No fallback branch.
    if (output && outputCache) {
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = THEME.palette[S.DEFAULT];
      ctx.font = chromeFont;
      const chromeBl = (cfs * (OUTPUT_LINE_H_MULT + 0.8)) / 2; // approximate ascent
      const maxLines = Math.min(outputCache.lineCount, MAX_OUTPUT_CANVAS_LINES);
      const ls = outputCache.lineStart;
      for (let i = 0; i < maxLines; i++) {
        const from = ls[i];
        const to = ls[i + 1] - 1;
        ctx.fillText(output.substring(from, to), originX + pl, codeBottomY + labelH + i * outputLH + chromeBl);
      }
    }
  }

  ctx.restore();
}
