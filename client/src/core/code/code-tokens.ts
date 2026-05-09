/**
 * Code Tokens — Style enum (S), THEME struct (palette + chrome), packed-triple
 * writers, length-bucketed keyword tables, and char-code sync tokenizer.
 *
 * Shared between code-system.ts (main thread), code-theme.ts, code-syntax-rules.ts,
 * and lezer-worker.ts. Spans live in CodeSpans (flat Uint16Array of
 * [offset, length, styleIndex] triples, `spanLineStart` half-open ranges per
 * source line). Whitespace runs are sentinelled to S.WHITESPACE inline — no
 * parallel buffer.
 */

import type { CodeLanguage } from '../accessors';
import type { CodeSource, CodeSpans } from './code-system';

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
// STYLE ENUM — 14 styles incl. WHITESPACE sentinel, fits in a byte
// ============================================================================

/** Numeric style tokens indexed into THEME.palette / isBold. */
export enum S {
  DEFAULT = 0,
  KEYWORD = 1,
  DEF_KW = 2,
  MODIFIER = 3,
  STRING = 4,
  NUMBER = 5,
  COMMENT = 6,
  FUNCTION = 7,
  VARIABLE = 8,
  TYPE = 9,
  OPERATOR = 10,
  ATTRIBUTE = 11,
  INVALID = 12,
  /** Sentinel — pure space/tab gap-fill. Renderer skips ink work entirely. */
  WHITESPACE = 13,
}

/** Bold: only KEYWORD, DEF_KW, MODIFIER (indices 1-3). */
export function isBold(s: number): boolean {
  return s >= 1 && s <= 3;
}

// ============================================================================
// THEME — single source of truth for colors + chrome (palette + chrome subset)
// ============================================================================

export interface ThemeSpec {
  /** Index = S enum value, length = enum count. */
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

export const COOLGLOW_THEME: ThemeSpec = {
  palette: [
    '#E0E0E0', // DEFAULT
    '#2BF1DC', // KEYWORD
    '#F8FBB1', // DEF_KW
    '#2BF1DC', // MODIFIER
    '#8DFF8E', // STRING
    '#62E9BD', // NUMBER
    '#AEAEAE', // COMMENT
    '#A3EBFF', // FUNCTION
    '#B683CA', // VARIABLE
    '#60A4F1', // TYPE
    '#2BF1DC', // OPERATOR
    '#7BACCA', // ATTRIBUTE
    '#FF5370', // INVALID
    '#E0E0E0', // WHITESPACE — same as DEFAULT for defensive blind palette reads
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

export const THEME: ThemeSpec = COOLGLOW_THEME;

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

// ============================================================================
// KEYWORD TABLES — length-bucketed, char-code-keyed, allocation-free classify
// ============================================================================
//
// Per-language `KwEntry[][]` indexed by identifier length. Each entry stores a
// Uint8Array of char codes plus the final S to emit. `classifyIdent` scans the
// length-bucket, comparing char codes — no `string.slice`, no `Set.has`
// allocation per identifier. The keyword/def-keyword/modifier classification
// (previously three `Set.has` per ident) collapses to one call.
//
// Reclassifications baked at table-build time so the sync tokenizer matches
// the lezer worker's tag-based output (no color flip on first parse arrival):
//   - true / false / null  (JS/TS) → S.NUMBER
//   - True / False / None  (Python) → S.NUMBER
//   - this / super         (JS/TS) → S.VARIABLE

interface KwEntry {
  codes: Uint8Array;
  style: S;
}

function buildKwTable(spec: readonly { word: string; style: S }[]): KwEntry[][] {
  const table: KwEntry[][] = [];
  for (const { word, style } of spec) {
    const len = word.length;
    if (!table[len]) table[len] = [];
    const codes = new Uint8Array(len);
    for (let i = 0; i < len; i++) codes[i] = word.charCodeAt(i);
    table[len].push({ codes, style });
  }
  return table;
}

const JS_KW_BY_LEN: KwEntry[][] = buildKwTable([
  // KEYWORD (control / general)
  { word: 'instanceof', style: S.KEYWORD },
  { word: 'continue', style: S.KEYWORD },
  { word: 'debugger', style: S.KEYWORD },
  { word: 'extends', style: S.KEYWORD },
  { word: 'finally', style: S.KEYWORD },
  { word: 'delete', style: S.KEYWORD },
  { word: 'return', style: S.KEYWORD },
  { word: 'switch', style: S.KEYWORD },
  { word: 'typeof', style: S.KEYWORD },
  { word: 'await', style: S.KEYWORD },
  { word: 'break', style: S.KEYWORD },
  { word: 'catch', style: S.KEYWORD },
  { word: 'throw', style: S.KEYWORD },
  { word: 'while', style: S.KEYWORD },
  { word: 'yield', style: S.KEYWORD },
  { word: 'case', style: S.KEYWORD },
  { word: 'else', style: S.KEYWORD },
  { word: 'enum', style: S.KEYWORD },
  { word: 'void', style: S.KEYWORD },
  { word: 'with', style: S.KEYWORD },
  { word: 'for', style: S.KEYWORD },
  { word: 'new', style: S.KEYWORD },
  { word: 'try', style: S.KEYWORD },
  { word: 'if', style: S.KEYWORD },
  { word: 'in', style: S.KEYWORD },
  { word: 'of', style: S.KEYWORD },
  { word: 'do', style: S.KEYWORD },
  // DEF_KW
  { word: 'function', style: S.DEF_KW },
  { word: 'class', style: S.DEF_KW },
  { word: 'const', style: S.DEF_KW },
  { word: 'let', style: S.DEF_KW },
  { word: 'var', style: S.DEF_KW },
  // MODIFIER
  { word: 'export', style: S.MODIFIER },
  { word: 'import', style: S.MODIFIER },
  { word: 'from', style: S.MODIFIER },
  { word: 'default', style: S.MODIFIER },
  { word: 'async', style: S.MODIFIER },
  // NUMBER (reclassified — matches worker tag output)
  { word: 'true', style: S.NUMBER },
  { word: 'false', style: S.NUMBER },
  { word: 'null', style: S.NUMBER },
  // VARIABLE (reclassified — matches worker tag output)
  { word: 'this', style: S.VARIABLE },
  { word: 'super', style: S.VARIABLE },
]);

const TS_KW_BY_LEN: KwEntry[][] = buildKwTable([
  // KEYWORD — JS subset (with `enum` REMOVED here; reclassified as DEF_KW for TS below)
  { word: 'instanceof', style: S.KEYWORD },
  { word: 'continue', style: S.KEYWORD },
  { word: 'debugger', style: S.KEYWORD },
  { word: 'extends', style: S.KEYWORD },
  { word: 'finally', style: S.KEYWORD },
  { word: 'delete', style: S.KEYWORD },
  { word: 'return', style: S.KEYWORD },
  { word: 'switch', style: S.KEYWORD },
  { word: 'typeof', style: S.KEYWORD },
  { word: 'await', style: S.KEYWORD },
  { word: 'break', style: S.KEYWORD },
  { word: 'catch', style: S.KEYWORD },
  { word: 'throw', style: S.KEYWORD },
  { word: 'while', style: S.KEYWORD },
  { word: 'yield', style: S.KEYWORD },
  { word: 'case', style: S.KEYWORD },
  { word: 'else', style: S.KEYWORD },
  { word: 'void', style: S.KEYWORD },
  { word: 'with', style: S.KEYWORD },
  { word: 'for', style: S.KEYWORD },
  { word: 'new', style: S.KEYWORD },
  { word: 'try', style: S.KEYWORD },
  { word: 'if', style: S.KEYWORD },
  { word: 'in', style: S.KEYWORD },
  { word: 'of', style: S.KEYWORD },
  { word: 'do', style: S.KEYWORD },
  // TS extras KEYWORD
  { word: 'implements', style: S.KEYWORD },
  { word: 'keyof', style: S.KEYWORD },
  { word: 'infer', style: S.KEYWORD },
  { word: 'never', style: S.KEYWORD },
  { word: 'any', style: S.KEYWORD },
  { word: 'as', style: S.KEYWORD },
  { word: 'is', style: S.KEYWORD },
  // DEF_KW (JS + TS, including `enum` reclassified)
  { word: 'function', style: S.DEF_KW },
  { word: 'class', style: S.DEF_KW },
  { word: 'const', style: S.DEF_KW },
  { word: 'let', style: S.DEF_KW },
  { word: 'var', style: S.DEF_KW },
  { word: 'type', style: S.DEF_KW },
  { word: 'interface', style: S.DEF_KW },
  { word: 'enum', style: S.DEF_KW },
  // MODIFIER (JS + TS extras)
  { word: 'export', style: S.MODIFIER },
  { word: 'import', style: S.MODIFIER },
  { word: 'from', style: S.MODIFIER },
  { word: 'default', style: S.MODIFIER },
  { word: 'async', style: S.MODIFIER },
  { word: 'declare', style: S.MODIFIER },
  { word: 'abstract', style: S.MODIFIER },
  { word: 'readonly', style: S.MODIFIER },
  { word: 'override', style: S.MODIFIER },
  { word: 'private', style: S.MODIFIER },
  { word: 'protected', style: S.MODIFIER },
  { word: 'public', style: S.MODIFIER },
  { word: 'namespace', style: S.MODIFIER },
  { word: 'module', style: S.MODIFIER },
  // NUMBER (reclassified)
  { word: 'true', style: S.NUMBER },
  { word: 'false', style: S.NUMBER },
  { word: 'null', style: S.NUMBER },
  // VARIABLE (reclassified)
  { word: 'this', style: S.VARIABLE },
  { word: 'super', style: S.VARIABLE },
]);

const PY_KW_BY_LEN: KwEntry[][] = buildKwTable([
  // KEYWORD
  { word: 'continue', style: S.KEYWORD },
  { word: 'finally', style: S.KEYWORD },
  { word: 'assert', style: S.KEYWORD },
  { word: 'except', style: S.KEYWORD },
  { word: 'return', style: S.KEYWORD },
  { word: 'raise', style: S.KEYWORD },
  { word: 'while', style: S.KEYWORD },
  { word: 'break', style: S.KEYWORD },
  { word: 'yield', style: S.KEYWORD },
  { word: 'pass', style: S.KEYWORD },
  { word: 'with', style: S.KEYWORD },
  { word: 'elif', style: S.KEYWORD },
  { word: 'else', style: S.KEYWORD },
  { word: 'and', style: S.KEYWORD },
  { word: 'del', style: S.KEYWORD },
  { word: 'for', style: S.KEYWORD },
  { word: 'not', style: S.KEYWORD },
  { word: 'try', style: S.KEYWORD },
  { word: 'as', style: S.KEYWORD },
  { word: 'if', style: S.KEYWORD },
  { word: 'in', style: S.KEYWORD },
  { word: 'is', style: S.KEYWORD },
  { word: 'or', style: S.KEYWORD },
  // DEF_KW
  { word: 'def', style: S.DEF_KW },
  { word: 'class', style: S.DEF_KW },
  { word: 'lambda', style: S.DEF_KW },
  // MODIFIER
  { word: 'global', style: S.MODIFIER },
  { word: 'nonlocal', style: S.MODIFIER },
  { word: 'from', style: S.MODIFIER },
  { word: 'import', style: S.MODIFIER },
  // NUMBER (reclassified)
  { word: 'True', style: S.NUMBER },
  { word: 'False', style: S.NUMBER },
  { word: 'None', style: S.NUMBER },
]);

function getKwTable(lang: CodeLanguage): KwEntry[][] {
  if (lang === 'python') return PY_KW_BY_LEN;
  if (lang === 'typescript') return TS_KW_BY_LEN;
  return JS_KW_BY_LEN;
}

/**
 * Linear scan of a length-bucket. Two char-code compares per candidate. No
 * string allocation. Returns the matched `S` or -1 on miss.
 */
function classifyIdent(text: string, start: number, end: number, table: KwEntry[][]): S | -1 {
  const len = end - start;
  const bucket = table[len];
  if (!bucket) return -1;
  outer: for (let i = 0; i < bucket.length; i++) {
    const codes = bucket[i].codes;
    for (let j = 0; j < len; j++) {
      if (text.charCodeAt(start + j) !== codes[j]) continue outer;
    }
    return bucket[i].style;
  }
  return -1;
}

// ============================================================================
// SYNC TOKENIZER — char-code, allocation-free, WYSIWYG-aligned with the worker
// ============================================================================
//
// Iterates `fullText` with absolute offsets; pushes line-relative triples to a
// pooled `_syncBuf`, then `packRunSpansInto` writes them into `out.spanData`
// with whitespace runs sentinelled to S.WHITESPACE.
//
// `lastSignificantChar` tracks the char code of the last emitted (non-ws,
// non-comment) char so `obj.foo` (lowercase ident after `.`, no `(` next)
// classifies as S.TYPE — matching the worker's tag-based classification.
//
// Out of scope (deferred to Sweet Dracula swap): destructured aliases,
// regex-delimiter split, JSX HTML/component tag split, escape-in-string,
// parameter vs variable distinction. Those need new S slots / AST awareness.

// Char-code helpers — '0'-'9' = 48-57, 'a'-'z' = 97-122, 'A'-'Z' = 65-90,
// '_' = 95, '$' = 36.
function isHexDigit(cc: number): boolean {
  return (cc >= 48 && cc <= 57) || (cc >= 97 && cc <= 102) || (cc >= 65 && cc <= 70);
}

function isIdentStart(cc: number): boolean {
  return (cc >= 97 && cc <= 122) || (cc >= 65 && cc <= 90) || cc === 95 || cc === 36;
}

function isIdentPart(cc: number): boolean {
  return isIdentStart(cc) || (cc >= 48 && cc <= 57);
}

function isDigit(cc: number): boolean {
  return cc >= 48 && cc <= 57;
}

function isOperator(cc: number): boolean {
  // + - * / = < > ! & | ^ ~ % ?
  return (
    cc === 43 ||
    cc === 45 ||
    cc === 42 ||
    cc === 47 ||
    cc === 61 ||
    cc === 60 ||
    cc === 62 ||
    cc === 33 ||
    cc === 38 ||
    cc === 124 ||
    cc === 94 ||
    cc === 126 ||
    cc === 37 ||
    cc === 63
  );
}

// Reusable buffer for highlight triples — reset per line via counter.
const _syncBuf: number[] = [];
let _syncBufCount = 0;

function pushTriple(from: number, to: number, style: number): void {
  const idx = _syncBufCount * 3;
  if (idx + 2 >= _syncBuf.length) _syncBuf.length = idx + 30;
  _syncBuf[idx] = from;
  _syncBuf[idx + 1] = to;
  _syncBuf[idx + 2] = style;
  _syncBufCount++;
}

// Mutable scanner state for decimal numbers.
let scanDecimalEnd = 0;
function scanDecimal(text: string, start: number, end: number): void {
  let i = start;
  while (i < end) {
    const cc = text.charCodeAt(i);
    if ((cc >= 48 && cc <= 57) || cc === 95) i++;
    else break;
  }
  if (i < end && text.charCodeAt(i) === 46) {
    i++;
    while (i < end) {
      const cc = text.charCodeAt(i);
      if ((cc >= 48 && cc <= 57) || cc === 95) i++;
      else break;
    }
  }
  if (i < end) {
    const cc = text.charCodeAt(i);
    if (cc === 101 || cc === 69) {
      i++;
      if (i < end) {
        const cc2 = text.charCodeAt(i);
        if (cc2 === 43 || cc2 === 45) i++;
      }
      while (i < end) {
        const cc2 = text.charCodeAt(i);
        if ((cc2 >= 48 && cc2 <= 57) || cc2 === 95) i++;
        else break;
      }
    }
  }
  scanDecimalEnd = i;
}

function findStringEnd(text: string, from: number, lineTo: number, quoteCC: number): number {
  for (let i = from; i < lineTo; i++) {
    const c = text.charCodeAt(i);
    if (c === 92) {
      i++;
      continue;
    }
    if (c === quoteCC) return i;
  }
  return -1;
}

/**
 * Scan a template literal body for ${} expressions. Pushes triples to
 * `_syncBuf` line-relative to `lineFromAbs`. Returns absolute end (after
 * closing `) or -1.
 */
function scanTemplateLiteral(text: string, start: number, lineTo: number, lineFromAbs: number): number {
  let i = start;
  let strStart = start;

  while (i < lineTo) {
    const cc = text.charCodeAt(i);
    if (cc === 92) {
      i += 2;
      continue;
    }
    if (cc === 96) {
      // closing `
      if (i > strStart) pushTriple(strStart - lineFromAbs, i - lineFromAbs, S.STRING);
      pushTriple(i - lineFromAbs, i + 1 - lineFromAbs, S.STRING);
      return i + 1;
    }
    if (cc === 36 && i + 1 < lineTo && text.charCodeAt(i + 1) === 123) {
      // ${
      if (i > strStart) pushTriple(strStart - lineFromAbs, i - lineFromAbs, S.STRING);
      i += 2;
      let depth = 1;
      while (i < lineTo && depth > 0) {
        const c = text.charCodeAt(i);
        if (c === 123) depth++;
        else if (c === 125) depth--;
        if (depth > 0) i++;
      }
      if (depth === 0) i++; // skip closing }
      strStart = i;
      continue;
    }
    i++;
  }

  if (i > strStart) pushTriple(strStart - lineFromAbs, lineTo - lineFromAbs, S.STRING);
  return -1;
}

/**
 * Sync regex tokenizer — packs triples directly into `out.spanData` per source
 * line. Single pass over `fullText` with absolute offsets. Whitespace gaps are
 * sentinelled to S.WHITESPACE inside `packRunSpansInto`. Hot path is
 * allocation-free (no `slice`, no `substring`, no `Set.has`).
 */
export function syncTokenizeInto(source: CodeSource, language: CodeLanguage, out: CodeSpans): void {
  const kwTable = getKwTable(language);
  const isPython = language === 'python';
  const lineCount = source.lineCount;
  const fullText = source.fullText;
  const lineStart = source.lineStart;

  ensureSpansLineCap(out, lineCount);
  out.lineCount = lineCount;
  out.spanLineStart[0] = 0;
  let writeOffset = 0;

  let inBlockComment = false;
  let inTemplateString = false;
  // Python triple-quoted string: 0 = not in, 34 = """, 39 = '''
  let inTripleString = 0;
  // Char code of last emitted non-whitespace, non-comment char. Drives
  // property-access classification (`obj.foo` → S.TYPE when prev sig char === '.').
  let lastSignificantChar = 0;

  for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
    const lineFrom = lineStart[lineIdx];
    const lineTo = lineStart[lineIdx + 1] - 1;
    const lineLen = lineTo - lineFrom;
    _syncBufCount = 0;
    let i = lineFrom;

    while (i < lineTo) {
      const cc = fullText.charCodeAt(i);

      // --- Block comment continuation (cross-line) ---
      if (inBlockComment) {
        const end = fullText.indexOf('*/', i);
        if (end === -1 || end >= lineTo) {
          pushTriple(i - lineFrom, lineTo - lineFrom, S.COMMENT);
          i = lineTo;
        } else {
          pushTriple(i - lineFrom, end + 2 - lineFrom, S.COMMENT);
          i = end + 2;
          inBlockComment = false;
        }
        continue;
      }

      // --- Template string continuation (cross-line) ---
      if (inTemplateString) {
        const end = scanTemplateLiteral(fullText, i, lineTo, lineFrom);
        if (end === -1) {
          i = lineTo;
        } else {
          i = end;
          inTemplateString = false;
          lastSignificantChar = 96;
        }
        continue;
      }

      // --- Python triple-quoted string continuation (cross-line) ---
      if (inTripleString !== 0) {
        const closeSeq = inTripleString === 34 ? '"""' : "'''";
        const end = fullText.indexOf(closeSeq, i);
        if (end === -1 || end >= lineTo) {
          pushTriple(i - lineFrom, lineTo - lineFrom, S.STRING);
          i = lineTo;
        } else {
          pushTriple(i - lineFrom, end + 3 - lineFrom, S.STRING);
          i = end + 3;
          lastSignificantChar = inTripleString;
          inTripleString = 0;
        }
        continue;
      }

      // --- Whitespace ---
      if (cc === 32 || cc === 9) {
        i++;
        continue;
      }

      // --- Hashbang on line 0 (JS/TS only) ---
      if (lineIdx === 0 && i === lineFrom && cc === 35 && i + 1 < lineTo && fullText.charCodeAt(i + 1) === 33 && !isPython) {
        pushTriple(0, lineLen, S.COMMENT);
        i = lineTo;
        continue;
      }

      // --- Line / block comments ---
      if (!isPython && cc === 47 && i + 1 < lineTo) {
        const next = fullText.charCodeAt(i + 1);
        if (next === 47) {
          // // — clamp to lineTo
          pushTriple(i - lineFrom, lineTo - lineFrom, S.COMMENT);
          i = lineTo;
          continue;
        }
        if (next === 42) {
          // /* — cross-line OK
          const end = fullText.indexOf('*/', i + 2);
          if (end === -1 || end >= lineTo) {
            pushTriple(i - lineFrom, lineTo - lineFrom, S.COMMENT);
            i = lineTo;
            inBlockComment = true;
          } else {
            pushTriple(i - lineFrom, end + 2 - lineFrom, S.COMMENT);
            i = end + 2;
          }
          continue;
        }
      }
      if (isPython && cc === 35) {
        // # — clamp to lineTo
        pushTriple(i - lineFrom, lineTo - lineFrom, S.COMMENT);
        i = lineTo;
        continue;
      }

      // --- Decorators ---
      if (cc === 64 && i + 1 < lineTo && isIdentStart(fullText.charCodeAt(i + 1))) {
        const start = i;
        i++;
        while (i < lineTo && isIdentPart(fullText.charCodeAt(i))) i++;
        pushTriple(start - lineFrom, i - lineFrom, S.MODIFIER);
        lastSignificantChar = fullText.charCodeAt(i - 1);
        continue;
      }

      // --- Strings ---
      if (cc === 34 || cc === 39 || cc === 96) {
        if (cc === 96 && !isPython) {
          // template literal — cross-line OK
          pushTriple(i - lineFrom, i + 1 - lineFrom, S.STRING);
          const end = scanTemplateLiteral(fullText, i + 1, lineTo, lineFrom);
          if (end === -1) {
            i = lineTo;
            inTemplateString = true;
          } else {
            i = end;
            lastSignificantChar = 96;
          }
          continue;
        }
        if (isPython && i + 2 < lineTo && fullText.charCodeAt(i + 1) === cc && fullText.charCodeAt(i + 2) === cc) {
          // Python triple-quoted — cross-line OK
          const closeSeq = cc === 34 ? '"""' : "'''";
          const end = fullText.indexOf(closeSeq, i + 3);
          if (end === -1 || end >= lineTo) {
            pushTriple(i - lineFrom, lineTo - lineFrom, S.STRING);
            i = lineTo;
            inTripleString = cc;
          } else {
            pushTriple(i - lineFrom, end + 3 - lineFrom, S.STRING);
            i = end + 3;
            lastSignificantChar = cc;
          }
          continue;
        }
        // Single/double quote — clamp to lineTo (newline terminates unterminated)
        const end = findStringEnd(fullText, i + 1, lineTo, cc);
        const stringEnd = end === -1 ? lineTo : end + 1;
        pushTriple(i - lineFrom, stringEnd - lineFrom, S.STRING);
        i = stringEnd;
        lastSignificantChar = cc;
        continue;
      }

      // --- Numbers (hex, binary, octal, scientific, separators, BigInt) ---
      if (isDigit(cc) || (cc === 46 && i + 1 < lineTo && isDigit(fullText.charCodeAt(i + 1)))) {
        const start = i;
        if (cc === 48 && i + 1 < lineTo) {
          const next = fullText.charCodeAt(i + 1);
          if (next === 120 || next === 88) {
            // 0x / 0X
            i += 2;
            while (i < lineTo) {
              const c = fullText.charCodeAt(i);
              if (isHexDigit(c) || c === 95) i++;
              else break;
            }
          } else if (next === 98 || next === 66) {
            // 0b / 0B
            i += 2;
            while (i < lineTo) {
              const c = fullText.charCodeAt(i);
              if (c === 48 || c === 49 || c === 95) i++;
              else break;
            }
          } else if (next === 111 || next === 79) {
            // 0o / 0O
            i += 2;
            while (i < lineTo) {
              const c = fullText.charCodeAt(i);
              if ((c >= 48 && c <= 55) || c === 95) i++;
              else break;
            }
          } else {
            scanDecimal(fullText, i, lineTo);
            i = scanDecimalEnd;
          }
        } else {
          scanDecimal(fullText, i, lineTo);
          i = scanDecimalEnd;
        }
        // BigInt suffix
        if (i < lineTo && fullText.charCodeAt(i) === 110) i++;
        pushTriple(start - lineFrom, i - lineFrom, S.NUMBER);
        // Reset so the next '.' doesn't trip property-access TYPE classification
        // on `1.toString()` (belt-and-suspenders — `(` lookahead would catch it
        // anyway but a bare `1.foo` should not classify `foo` as TYPE).
        lastSignificantChar = 0;
        continue;
      }

      // --- Python string prefixes (f/r/b) ---
      if (isPython && (cc === 102 || cc === 114 || cc === 98 || cc === 70 || cc === 82 || cc === 66)) {
        const next = i + 1 < lineTo ? fullText.charCodeAt(i + 1) : 0;
        if (next === 34 || next === 39) {
          const start = i;
          i++; // skip prefix
          const q = fullText.charCodeAt(i);
          if (i + 2 < lineTo && fullText.charCodeAt(i + 1) === q && fullText.charCodeAt(i + 2) === q) {
            const closeSeq = q === 34 ? '"""' : "'''";
            const end = fullText.indexOf(closeSeq, i + 3);
            if (end === -1 || end >= lineTo) {
              pushTriple(start - lineFrom, lineTo - lineFrom, S.STRING);
              i = lineTo;
              inTripleString = q;
            } else {
              pushTriple(start - lineFrom, end + 3 - lineFrom, S.STRING);
              i = end + 3;
            }
          } else {
            const end = findStringEnd(fullText, i + 1, lineTo, q);
            const stringEnd = end === -1 ? lineTo : end + 1;
            pushTriple(start - lineFrom, stringEnd - lineFrom, S.STRING);
            i = stringEnd;
          }
          lastSignificantChar = q;
          continue;
        }
      }

      // --- Identifiers / keywords ---
      if (isIdentStart(cc)) {
        const start = i;
        i++;
        while (i < lineTo && isIdentPart(fullText.charCodeAt(i))) i++;

        const kwStyle = classifyIdent(fullText, start, i, kwTable);
        if (kwStyle !== -1) {
          pushTriple(start - lineFrom, i - lineFrom, kwStyle);
        } else if (i < lineTo && fullText.charCodeAt(i) === 40) {
          // Followed by `(` → function call
          pushTriple(start - lineFrom, i - lineFrom, S.FUNCTION);
        } else {
          const firstCC = fullText.charCodeAt(start);
          if (firstCC >= 65 && firstCC <= 90) {
            // PascalCase → TYPE
            pushTriple(start - lineFrom, i - lineFrom, S.TYPE);
          } else if (lastSignificantChar === 46) {
            // Property access (lowercase ident after '.', no '(' next) → TYPE
            pushTriple(start - lineFrom, i - lineFrom, S.TYPE);
          } else {
            pushTriple(start - lineFrom, i - lineFrom, S.VARIABLE);
          }
        }
        lastSignificantChar = fullText.charCodeAt(i - 1);
        continue;
      }

      // --- Operators (including =>, ?., ??) ---
      if (isOperator(cc)) {
        const start = i;
        i++;
        while (i < lineTo && isOperator(fullText.charCodeAt(i))) i++;
        pushTriple(start - lineFrom, i - lineFrom, S.OPERATOR);
        lastSignificantChar = fullText.charCodeAt(i - 1);
        continue;
      }

      // --- Spread/rest ---
      if (cc === 46 && i + 2 < lineTo && fullText.charCodeAt(i + 1) === 46 && fullText.charCodeAt(i + 2) === 46) {
        pushTriple(i - lineFrom, i + 3 - lineFrom, S.OPERATOR);
        i += 3;
        lastSignificantChar = 46;
        continue;
      }

      // --- Everything else (punctuation, unknown) → gap, filled by packRunSpansInto.
      //     Update lastSignificantChar so a trailing `.` enables property-access TYPE
      //     classification on the next ident. Comments and whitespace deliberately
      //     do NOT update it, so `obj /* */ . foo` still resolves `foo` as TYPE.
      lastSignificantChar = cc;
      i++;
    }

    writeOffset = packRunSpansInto(out, lineLen, _syncBuf, _syncBufCount, writeOffset, fullText, lineFrom);
    out.spanLineStart[lineIdx + 1] = writeOffset;
  }
}
