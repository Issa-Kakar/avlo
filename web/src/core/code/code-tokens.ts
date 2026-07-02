/**
 * Code Tokens — the shared codec/theme/plumbing. Style enum (S), THEME struct
 * (palette + chrome), sizing constants, play-button geometry, spans-buffer cap
 * helpers, and the packed-triple writers.
 *
 * Deliberately free of the sync tokenizer (that lives in `code-tokenizer.ts`) so
 * this file's import graph stays tiny: it is shared between code-system.ts (main
 * thread), code-theme.ts, and lezer-worker.ts, and the worker must never reach
 * `code-system.ts` (which pulls in RenderLoop → image-manager → top-level
 * `window`). Keeping `code-system` a `type`-only import here preserves that.
 *
 * Spans live in CodeSpans (flat Uint16Array of [offset, length, styleIndex]
 * triples, `spanLineStart` half-open ranges per source line). Whitespace runs
 * are sentinelled to S.WHITESPACE inline — no parallel buffer.
 */

import type { CodeSpans } from './code-system';

// ============================================================================
// SPANS BUFFER CAP HELPERS — defined here (not in code-system) so the lezer
// worker's import graph stays free of `code-system.ts` (which pulls in
// RenderLoop → image-manager → top-level `window` access).
// ============================================================================

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
  // Floor to 16 so a worker response with empty spanData (length 0) doesn't
  // trip `while (cap < n) cap *= 2` into an infinite loop.
  let cap = Math.max(s.spanCap, 16);
  while (cap < n) cap *= 2;
  const next = new Uint16Array(cap);
  next.set(s.spanData);
  s.spanData = next;
  s.spanCap = cap;
}

// ============================================================================
// STYLE ENUM — 16 styles incl. WHITESPACE sentinel, fits in a byte
// ============================================================================

/** Numeric style tokens indexed into THEME.palette. */
export enum S {
  DEFAULT = 0,
  KEYWORD = 1,
  STORAGE = 2,
  MODIFIER = 3,
  STRING = 4,
  NUMBER = 5,
  COMMENT = 6,
  FUNCTION_DEF = 7,
  VARIABLE = 8,
  TYPE = 9,
  OPERATOR = 10,
  ATTRIBUTE = 11,
  INVALID = 12,
  FUNCTION_CALL = 13,
  LANG_VAR = 14,
  /** Sentinel — pure space/tab gap-fill. Renderer skips ink work entirely. */
  WHITESPACE = 15,
}

// ============================================================================
// THEME — single source of truth for colors + chrome (palette + chrome subset)
// ============================================================================

export interface ThemeSpec {
  /** Index = S enum value, length = enum count (16). */
  palette: readonly string[];
  chrome: {
    bg: string;
    gutter: string;
    selection: string;
    lineHl: string;
    caret: string;
    /** CM nonmatchingBracket color/outline. */
    nonmatchBracket: string;
    /** CM searchMatch background. */
    searchMatch: string;
    /** Header/output separator hairline. */
    sep: string;
    /** Title text in header bar. */
    title: string;
    playGreen: string;
    playBg: string;
    outputLabel: string;
    outputText: string;
    /** Title input placeholder color. */
    placeholder: string;
  };
}

// CoolGlow chrome + Sweet Dracula palette
export const CODE_THEME: ThemeSpec = {
  palette: [
    '#F8F8F2', //  0 DEFAULT       — fg
    '#FF79C6', //  1 KEYWORD       — pink
    '#8BE9FD', //  2 STORAGE       — cyan (function/class/const/let/var/type/interface/enum/def/lambda)
    '#FF79C6', //  3 MODIFIER      — pink (export/import/from/async/static/declare/...)
    '#F1FA8C', //  4 STRING        — yellow
    '#BD93F9', //  5 NUMBER        — purple (incl. true/false/null)
    '#AEAEAE', //  6 COMMENT       — light grey (CoolGlow chrome contrast)
    '#50FA7B', //  7 FUNCTION_DEF  — green (function defs, class names)
    '#F8F8F2', //  8 VARIABLE      — fg (plain identifiers)
    '#8BE9FD', //  9 TYPE          — cyan (PascalCase types, primitives, property names)
    '#FF79C6', // 10 OPERATOR      — pink (operators, derefs, escapes inside strings)
    '#50FA7B', // 11 ATTRIBUTE     — green (JSX attribute names)
    '#FF5555', // 12 INVALID       — red
    '#50FA7B', // 13 FUNCTION_CALL — green (function invocations — matches FUNCTION_DEF)
    '#BD93F9', // 14 LANG_VAR      — purple (this/super/self, decorators, magic funcs)
    '#F8F8F2', // 15 WHITESPACE    — mirrors DEFAULT (defensive blind palette reads)
  ],
  chrome: {
    bg: '#060521',
    gutter: '#E0E0E090',
    selection: '#122BBB',
    lineHl: '#FFFFFF0F',
    caret: '#FFFFFFA6',
    nonmatchBracket: '#FF5370',
    searchMatch: '#FFD43B40',
    sep: '#FFFFFF20',
    title: '#AEAEAE',
    playGreen: '#4ADE80',
    playBg: '#4ADE8035',
    outputLabel: '#E0E0E090',
    outputText: '#AEAEAE',
    placeholder: '#E0E0E060',
  },
};

export const THEME: ThemeSpec = CODE_THEME;

// ============================================================================
// CONSTANTS — sizing (font, line height, chrome ratios, limits)
// ============================================================================

export const CODE_FONT_FAMILY = 'JetBrains Mono';
export const LINE_HEIGHT_MULT = 1.5;
export const CHROME_FONT_RATIO = 0.72;
export const HEADER_HEIGHT_RATIO = 2.5;
export const OUTPUT_LABEL_H_RATIO = 2.0;
export const OUTPUT_LINE_H_MULT = 1.4;
export const OUTPUT_PAD_BOTTOM_RATIO = 0.8;
export const MAX_OUTPUT_CANVAS_LINES = 12;
export const MAX_OUTPUT_CHARS = 4096;
export const MAX_TITLE_LENGTH = 48;

/**
 * Single source of truth for the play-button triangle proportions. Used by
 * both the canvas renderer and the DOM SVG inside the editor header so the
 * two stay pixel-aligned at every zoom.
 *
 * The triangle is centroid-balanced: shifted left by `triW / 3` so the
 * triangle's geometric centroid sits at `btnCx`. SVG viewBox `17 0 0 20`
 * (apex at right midpoint, base on left) matches `triW : triH = 0.85 : 1`.
 */
export function playButtonGeom(fontSize: number): { btnR: number; triW: number; triH: number; triXOffset: number } {
  const btnR = fontSize * 0.5;
  const triH = btnR * 0.9;
  const triW = triH * 0.85;
  return { btnR, triW, triH, triXOffset: triW / 3 };
}

// ============================================================================
// PACK TRIPLES — flat [offset, length, style] u16 packing, whitespace inline
// ============================================================================

/**
 * Number of gap-filled triples produced by packing `(buf, count)` for a line of length `lineLen`.
 * Empty line → 0 triples; line with no highlights → 1 default-fill triple.
 */
export function countPackedTriples(lineLen: number, buf: number[], count: number): number {
  if (lineLen === 0) return 0;
  if (count === 0) return 1;
  let runCount = 0;
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const from = buf[i * 3];
    const to = buf[i * 3 + 1];
    if (from > pos) runCount++;
    if (to > from) runCount++;
    pos = to;
  }
  if (pos < lineLen) runCount++;
  return runCount;
}

function isAllWs(text: string, fromAbs: number, toAbs: number): boolean {
  for (let ci = fromAbs; ci < toAbs; ci++) {
    const cc = text.charCodeAt(ci);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/**
 * Write gap-filled triples into `spanData` starting at `runOffset`. Caller is
 * responsible for ensuring `spanData` has capacity at
 * `runOffset + countPackedTriples(...) * 3`. Pure space/tab gap runs are
 * emitted as `S.WHITESPACE` (renderer skips ink work entirely on that triple);
 * non-whitespace gaps stay `S.DEFAULT`. Returns the new write offset.
 */
export function writePackedTriples(
  spanData: Uint16Array,
  lineLen: number,
  buf: number[],
  count: number,
  runOffset: number,
  lineText: string,
  lineFromAbs: number,
): number {
  if (lineLen === 0) return runOffset;

  if (count === 0) {
    spanData[runOffset] = 0;
    spanData[runOffset + 1] = lineLen;
    spanData[runOffset + 2] = isAllWs(lineText, lineFromAbs, lineFromAbs + lineLen) ? S.WHITESPACE : S.DEFAULT;
    return runOffset + 3;
  }

  let wi = runOffset;
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const from = buf[i * 3];
    const to = buf[i * 3 + 1];
    const style = buf[i * 3 + 2];
    if (from > pos) {
      spanData[wi] = pos;
      spanData[wi + 1] = from - pos;
      spanData[wi + 2] = isAllWs(lineText, lineFromAbs + pos, lineFromAbs + from) ? S.WHITESPACE : S.DEFAULT;
      wi += 3;
    }
    if (to > from) {
      spanData[wi] = from;
      spanData[wi + 1] = to - from;
      spanData[wi + 2] = style;
      wi += 3;
    }
    pos = to;
  }
  if (pos < lineLen) {
    spanData[wi] = pos;
    spanData[wi + 1] = lineLen - pos;
    spanData[wi + 2] = isAllWs(lineText, lineFromAbs + pos, lineFromAbs + lineLen) ? S.WHITESPACE : S.DEFAULT;
    wi += 3;
  }
  return wi;
}

/** Pack triples into a `CodeSpans` buffer, growing capacity as needed. Returns new write offset. */
export function packRunSpansInto(
  out: CodeSpans,
  lineLen: number,
  buf: number[],
  count: number,
  runOffset: number,
  lineText: string,
  lineFromAbs: number,
): number {
  const triples = countPackedTriples(lineLen, buf, count);
  ensureSpansDataCap(out, runOffset + triples * 3);
  return writePackedTriples(out.spanData, lineLen, buf, count, runOffset, lineText, lineFromAbs);
}
