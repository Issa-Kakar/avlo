/**
 * Code Tokens — Style enum, packed-triple writers, color palette, keyword sets,
 * sync tokenizer, and gap-fill algorithm.
 *
 * Shared between code-system.ts (main thread), code-theme.ts, and lezer-worker.ts.
 * Spans live in CodeSpans (flat Uint16Array of [offset, length, styleIndex] triples,
 * `spanLineStart` half-open ranges per source line).
 */

import type { CodeLanguage } from '../accessors';
import type { CodeSource, CodeSpans } from './code-system';
import { ensureSpansDataCap, ensureSpansLineCap } from './code-system';

// ============================================================================
// STYLE ENUM — 13 styles, fits in a byte
// ============================================================================

/** Numeric style tokens indexed into PALETTE / isBold. */
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
}

// ============================================================================
// PALETTE — index = S value. Single source of truth for colors.
// ============================================================================

export const PALETTE: readonly string[] = [
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
];

/** Bold: only KEYWORD, DEF_KW, MODIFIER (indices 1-3). */
export function isBold(s: number): boolean {
  return s >= 1 && s <= 3;
}

// ============================================================================
// CONSTANTS — CoolGlow palette (chrome)
// ============================================================================

export const CODE_BG = '#060521';
export const CODE_DEFAULT = '#E0E0E0';
export const CODE_GUTTER = '#E0E0E090';
export const CODE_SELECTION = '#122BBB';
export const CODE_LINE_HL = '#FFFFFF0F';
export const CODE_CARET = '#FFFFFFA6';

// ============================================================================
// Named token colors — kept for CM theme + sync tokenizer keyword sets
// ============================================================================

export const KEYWORD = '#2BF1DC';
export const DEF_KEYWORD = '#F8FBB1';
export const MODIFIER = '#2BF1DC';
export const STRING = '#8DFF8E';
export const NUMBER = '#62E9BD';
export const COMMENT = '#AEAEAE';
export const FUNCTION = '#A3EBFF';
export const VARIABLE = '#B683CA';
export const TYPE = '#60A4F1';
export const OPERATOR = '#2BF1DC';
export const ATTRIBUTE = '#7BACCA';

export const CODE_FONT_FAMILY = 'JetBrains Mono';
export const LINE_HEIGHT_MULT = 1.5;

// ============================================================================
// CHROME CONSTANTS — header bar, output panel
// ============================================================================

export const CHROME_FONT_RATIO = 0.72;
export const HEADER_HEIGHT_RATIO = 2.5;
export const OUTPUT_LABEL_H_RATIO = 2.0;
export const OUTPUT_LINE_H_MULT = 1.4;
export const OUTPUT_PAD_BOTTOM_RATIO = 0.8;
export const MAX_OUTPUT_CANVAS_LINES = 12;
export const MAX_OUTPUT_CHARS = 4096;
export const MAX_TITLE_LENGTH = 48;

export const CODE_SEPARATOR = '#FFFFFF20';
export const CODE_TITLE_COLOR = '#AEAEAE';
export const CODE_PLAY_GREEN = '#4ADE80';
export const CODE_PLAY_BG = '#4ADE8035';
export const CODE_OUTPUT_LABEL = '#E0E0E090';

// ============================================================================
// TAG_STYLES / TAG_STYLE_INDEX
// ============================================================================

/** TAG_STYLES map — derived from PALETTE. Used by CM HighlightStyle. */
export const TAG_STYLES: Record<string, { color: string; bold?: boolean }> = {
  keyword: { color: PALETTE[S.KEYWORD], bold: true },
  'def-keyword': { color: PALETTE[S.DEF_KW], bold: true },
  modifier: { color: PALETTE[S.MODIFIER], bold: true },
  string: { color: PALETTE[S.STRING] },
  number: { color: PALETTE[S.NUMBER] },
  comment: { color: PALETTE[S.COMMENT] },
  function: { color: PALETTE[S.FUNCTION] },
  variable: { color: PALETTE[S.VARIABLE] },
  type: { color: PALETTE[S.TYPE] },
  operator: { color: PALETTE[S.OPERATOR] },
  attribute: { color: PALETTE[S.ATTRIBUTE] },
  deref: { color: PALETTE[S.DEFAULT] },
  punctuation: { color: PALETTE[S.DEFAULT] },
  invalid: { color: PALETTE[S.INVALID] },
};

/** Maps Lezer tag class names to S enum values. Used by worker. */
export const TAG_STYLE_INDEX: Record<string, number> = {
  keyword: S.KEYWORD,
  'def-keyword': S.DEF_KW,
  modifier: S.MODIFIER,
  string: S.STRING,
  number: S.NUMBER,
  comment: S.COMMENT,
  function: S.FUNCTION,
  variable: S.VARIABLE,
  type: S.TYPE,
  operator: S.OPERATOR,
  attribute: S.ATTRIBUTE,
  deref: S.DEFAULT,
  punctuation: S.DEFAULT,
  invalid: S.INVALID,
};

// ============================================================================
// PACK TRIPLES — flat [offset, length, style] u16 packing
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

/**
 * Write gap-filled triples into `spanData` starting at `runOffset`. Caller is responsible
 * for ensuring `spanData` has capacity at `runOffset + countPackedTriples(...) * 3`.
 * Returns the new offset after the writes.
 */
export function writePackedTriples(spanData: Uint16Array, lineLen: number, buf: number[], count: number, runOffset: number): number {
  if (lineLen === 0) return runOffset;
  if (count === 0) {
    spanData[runOffset] = 0;
    spanData[runOffset + 1] = lineLen;
    spanData[runOffset + 2] = S.DEFAULT;
    return runOffset + 3;
  }
  let wi = runOffset;
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const from = buf[i * 3];
    const to = buf[i * 3 + 1];
    const style = buf[i * 3 + 2];
    if (from > pos) {
      spanData[wi++] = pos;
      spanData[wi++] = from - pos;
      spanData[wi++] = S.DEFAULT;
    }
    if (to > from) {
      spanData[wi++] = from;
      spanData[wi++] = to - from;
      spanData[wi++] = style;
    }
    pos = to;
  }
  if (pos < lineLen) {
    spanData[wi++] = pos;
    spanData[wi++] = lineLen - pos;
    spanData[wi++] = S.DEFAULT;
  }
  return wi;
}

/** Pack triples into a `CodeSpans` buffer, growing capacity as needed. Returns new write offset. */
export function packRunSpansInto(out: CodeSpans, lineLen: number, buf: number[], count: number, runOffset: number): number {
  const triples = countPackedTriples(lineLen, buf, count);
  ensureSpansDataCap(out, runOffset + triples * 3);
  return writePackedTriples(out.spanData, lineLen, buf, count, runOffset);
}

// ============================================================================
// KEYWORD SETS — sorted longest-first for greedy match
// ============================================================================

const JS_KEYWORDS = [
  'instanceof',
  'continue',
  'debugger',
  'function',
  'default',
  'extends',
  'finally',
  'delete',
  'export',
  'import',
  'return',
  'switch',
  'typeof',
  'async',
  'await',
  'break',
  'catch',
  'class',
  'const',
  'false',
  'super',
  'throw',
  'while',
  'yield',
  'case',
  'else',
  'enum',
  'from',
  'null',
  'this',
  'true',
  'void',
  'with',
  'for',
  'let',
  'new',
  'try',
  'var',
  'if',
  'in',
  'of',
  'do',
];

const TS_EXTRAS = [
  'implements',
  'interface',
  'namespace',
  'protected',
  'abstract',
  'readonly',
  'override',
  'private',
  'declare',
  'public',
  'module',
  'keyof',
  'infer',
  'never',
  'type',
  'any',
  'as',
  'is',
];

const PY_KEYWORDS = [
  'continue',
  'nonlocal',
  'finally',
  'lambda',
  'global',
  'assert',
  'except',
  'import',
  'return',
  'False',
  'raise',
  'while',
  'break',
  'class',
  'yield',
  'None',
  'True',
  'from',
  'pass',
  'with',
  'elif',
  'else',
  'and',
  'def',
  'del',
  'for',
  'not',
  'try',
  'as',
  'if',
  'in',
  'is',
  'or',
];

const jsKeywordSet = new Set(JS_KEYWORDS);
const tsKeywordSet = new Set([...JS_KEYWORDS, ...TS_EXTRAS]);
const pyKeywordSet = new Set(PY_KEYWORDS);

function getKeywordSet(lang: CodeLanguage): Set<string> {
  if (lang === 'python') return pyKeywordSet;
  if (lang === 'typescript') return tsKeywordSet;
  return jsKeywordSet;
}

// ============================================================================
// KEYWORD CLASSIFICATION — definition / modifier / control
// ============================================================================

// Definition keywords → S.DEF_KW (yellow)
const jsDefKwSet = new Set(['function', 'class', 'const', 'let', 'var']);
const tsDefExtras = new Set(['type', 'interface', 'enum']);
const pyDefKwSet = new Set(['def', 'class', 'lambda']);

// Modifier / module keywords → S.MODIFIER (cyan)
const jsModifierSet = new Set(['export', 'import', 'from', 'default', 'async', 'static']);
const tsModifierExtras = new Set(['declare', 'abstract', 'readonly', 'override', 'private', 'protected', 'public', 'namespace', 'module']);
const pyModifierSet = new Set(['global', 'nonlocal', 'from', 'import', 'async']);

function keywordStyle(word: string, lang: CodeLanguage): number {
  if (lang === 'python') {
    if (pyDefKwSet.has(word)) return S.DEF_KW;
    if (pyModifierSet.has(word)) return S.MODIFIER;
  } else if (lang === 'typescript') {
    if (jsDefKwSet.has(word) || tsDefExtras.has(word)) return S.DEF_KW;
    if (jsModifierSet.has(word) || tsModifierExtras.has(word)) return S.MODIFIER;
  } else {
    if (jsDefKwSet.has(word)) return S.DEF_KW;
    if (jsModifierSet.has(word)) return S.MODIFIER;
  }
  return S.KEYWORD;
}

// ============================================================================
// TOKENIZER BUFFER & HELPERS
// ============================================================================

// Reusable buffer for highlight triples — reset per line via counter
const _syncBuf: number[] = [];
let _syncBufCount = 0;

function pushTriple(from: number, to: number, style: number): void {
  const idx = _syncBufCount * 3;
  if (idx + 2 >= _syncBuf.length) _syncBuf.length = idx + 30; // grow in chunks
  _syncBuf[idx] = from;
  _syncBuf[idx + 1] = to;
  _syncBuf[idx + 2] = style;
  _syncBufCount++;
}

function isHexDigit(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function isOperator(ch: string): boolean {
  return (
    ch === '+' ||
    ch === '-' ||
    ch === '*' ||
    ch === '/' ||
    ch === '=' ||
    ch === '<' ||
    ch === '>' ||
    ch === '!' ||
    ch === '&' ||
    ch === '|' ||
    ch === '^' ||
    ch === '~' ||
    ch === '%' ||
    ch === '?'
  );
}

// Mutable scanner state for decimal numbers (avoids allocation)
let scanDecimalEnd = 0;
function scanDecimal(line: string, start: number): void {
  let i = start;
  while (i < line.length && ((line[i] >= '0' && line[i] <= '9') || line[i] === '_')) i++;
  if (i < line.length && line[i] === '.') {
    i++;
    while (i < line.length && ((line[i] >= '0' && line[i] <= '9') || line[i] === '_')) i++;
  }
  if (i < line.length && (line[i] === 'e' || line[i] === 'E')) {
    i++;
    if (i < line.length && (line[i] === '+' || line[i] === '-')) i++;
    while (i < line.length && ((line[i] >= '0' && line[i] <= '9') || line[i] === '_')) i++;
  }
  scanDecimalEnd = i;
}

function findStringEnd(line: string, start: number, quote: string): number {
  for (let i = start; i < line.length; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === quote) return i;
  }
  return -1;
}

/**
 * Scan a template literal body for ${} expressions.
 * Pushes triples directly into _syncBuf. Returns end position (after closing `) or -1.
 */
function scanTemplateLiteral(line: string, start: number): number {
  let i = start;
  let strStart = start;

  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2; // skip escape
      continue;
    }
    if (line[i] === '`') {
      // End of template literal
      if (i > strStart) {
        pushTriple(strStart, i, S.STRING);
      }
      pushTriple(i, i + 1, S.STRING); // closing `
      return i + 1;
    }
    if (line[i] === '$' && i + 1 < line.length && line[i + 1] === '{') {
      // String portion before ${
      if (i > strStart) {
        pushTriple(strStart, i, S.STRING);
      }
      // ${ itself — skip, gap-filled as default
      i += 2;
      // Scan expression until matching }
      let depth = 1;
      while (i < line.length && depth > 0) {
        if (line[i] === '{') depth++;
        else if (line[i] === '}') depth--;
        if (depth > 0) i++;
      }
      if (depth === 0) i++; // skip closing }
      strStart = i;
      continue;
    }
    i++;
  }

  // Unterminated — rest is string
  if (i > strStart) {
    pushTriple(strStart, line.length, S.STRING);
  }
  return -1;
}

// ============================================================================
// SYNC TOKENIZER — writes flat triples into a pooled CodeSpans buffer
// ============================================================================

/**
 * Sync regex tokenizer — packs triples directly into `out.spanData` per source line,
 * recording the running offset in `out.spanLineStart`. Gaps between highlights are
 * filled with S.DEFAULT. Single substring per line drives the existing inner tokenizer
 * logic; no `string[]` array, no per-line ArrayBuffer.
 */
export function syncTokenizeInto(source: CodeSource, language: CodeLanguage, out: CodeSpans): void {
  const kwSet = getKeywordSet(language);
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

  for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
    const lineFrom = lineStart[lineIdx];
    const lineTo = lineStart[lineIdx + 1] - 1;
    // One substring per line — feeds the existing index-based tokenizer body.
    const line = fullText.substring(lineFrom, lineTo);
    _syncBufCount = 0;
    let i = 0;

    while (i < line.length) {
      // --- Block comment continuation ---
      if (inBlockComment) {
        const end = line.indexOf('*/', i);
        if (end === -1) {
          pushTriple(i, line.length, S.COMMENT);
          i = line.length;
        } else {
          pushTriple(i, end + 2, S.COMMENT);
          i = end + 2;
          inBlockComment = false;
        }
        continue;
      }

      // --- Template string continuation ---
      if (inTemplateString) {
        const end = scanTemplateLiteral(line, i);
        if (end === -1) {
          i = line.length;
        } else {
          i = end;
          inTemplateString = false;
        }
        continue;
      }

      const ch = line[i];

      // --- Whitespace: skip (gap-fill handles it) ---
      if (ch === ' ' || ch === '\t') {
        i++;
        continue;
      }

      // --- Hashbang on line 0 ---
      if (lineIdx === 0 && i === 0 && ch === '#' && i + 1 < line.length && line[i + 1] === '!' && !isPython) {
        pushTriple(i, line.length, S.COMMENT);
        i = line.length;
        continue;
      }

      // --- Line comments ---
      if (!isPython && ch === '/' && i + 1 < line.length) {
        if (line[i + 1] === '/') {
          pushTriple(i, line.length, S.COMMENT);
          i = line.length;
          continue;
        }
        if (line[i + 1] === '*') {
          const end = line.indexOf('*/', i + 2);
          if (end === -1) {
            pushTriple(i, line.length, S.COMMENT);
            i = line.length;
            inBlockComment = true;
          } else {
            pushTriple(i, end + 2, S.COMMENT);
            i = end + 2;
          }
          continue;
        }
      }
      if (isPython && ch === '#') {
        pushTriple(i, line.length, S.COMMENT);
        i = line.length;
        continue;
      }

      // --- Decorators ---
      if (ch === '@' && i + 1 < line.length && isIdentStart(line[i + 1])) {
        const start = i;
        i++; // skip @
        while (i < line.length && isIdentPart(line[i])) i++;
        pushTriple(start, i, S.MODIFIER);
        continue;
      }

      // --- Strings ---
      if (ch === '"' || ch === "'" || ch === '`') {
        if (ch === '`' && !isPython) {
          // Template literal with ${} expression support
          pushTriple(i, i + 1, S.STRING); // opening `
          const end = scanTemplateLiteral(line, i + 1);
          if (end === -1) {
            i = line.length;
            inTemplateString = true;
          } else {
            i = end;
          }
          continue;
        }
        // Python triple quotes
        if (isPython && i + 2 < line.length && line[i + 1] === ch && line[i + 2] === ch) {
          const closeSeq = ch + ch + ch;
          const end = line.indexOf(closeSeq, i + 3);
          if (end === -1) {
            pushTriple(i, line.length, S.STRING);
            i = line.length;
          } else {
            pushTriple(i, end + 3, S.STRING);
            i = end + 3;
          }
          continue;
        }
        const end = findStringEnd(line, i + 1, ch);
        pushTriple(i, end === -1 ? line.length : end + 1, S.STRING);
        i = end === -1 ? line.length : end + 1;
        continue;
      }

      // --- Numbers (hex, binary, octal, scientific, separators, BigInt) ---
      if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < line.length && line[i + 1] >= '0' && line[i + 1] <= '9')) {
        const start = i;
        if (ch === '0' && i + 1 < line.length) {
          const next = line[i + 1];
          if (next === 'x' || next === 'X') {
            i += 2;
            while (i < line.length && (isHexDigit(line[i]) || line[i] === '_')) i++;
          } else if (next === 'b' || next === 'B') {
            i += 2;
            while (i < line.length && (line[i] === '0' || line[i] === '1' || line[i] === '_')) i++;
          } else if (next === 'o' || next === 'O') {
            i += 2;
            while (i < line.length && ((line[i] >= '0' && line[i] <= '7') || line[i] === '_')) i++;
          } else {
            scanDecimal(line, i);
            i = scanDecimalEnd;
          }
        } else {
          scanDecimal(line, i);
          i = scanDecimalEnd;
        }
        // BigInt suffix
        if (i < line.length && line[i] === 'n') i++;
        pushTriple(start, i, S.NUMBER);
        continue;
      }

      // --- Python string prefixes (f/r/b) ---
      if (isPython && (ch === 'f' || ch === 'r' || ch === 'b' || ch === 'F' || ch === 'R' || ch === 'B')) {
        const nextCh = i + 1 < line.length ? line[i + 1] : '';
        if (nextCh === '"' || nextCh === "'") {
          const start = i;
          i++; // skip prefix
          const q = line[i];
          // Triple quote?
          if (i + 2 < line.length && line[i + 1] === q && line[i + 2] === q) {
            const closeSeq = q + q + q;
            const end = line.indexOf(closeSeq, i + 3);
            if (end === -1) {
              pushTriple(start, line.length, S.STRING);
              i = line.length;
            } else {
              pushTriple(start, end + 3, S.STRING);
              i = end + 3;
            }
          } else {
            const end = findStringEnd(line, i + 1, q);
            pushTriple(start, end === -1 ? line.length : end + 1, S.STRING);
            i = end === -1 ? line.length : end + 1;
          }
          continue;
        }
      }

      // --- Identifiers / keywords ---
      if (isIdentStart(ch)) {
        const start = i;
        i++;
        while (i < line.length && isIdentPart(line[i])) i++;
        const word = line.slice(start, i);

        if (kwSet.has(word)) {
          pushTriple(start, i, keywordStyle(word, language));
        } else if (i < line.length && line[i] === '(') {
          pushTriple(start, i, S.FUNCTION);
        } else if (word[0] >= 'A' && word[0] <= 'Z') {
          pushTriple(start, i, S.TYPE);
        } else {
          pushTriple(start, i, S.VARIABLE);
        }
        continue;
      }

      // --- Operators (including =>, ?., ??, ...) ---
      if (isOperator(ch)) {
        const start = i;
        i++;
        while (i < line.length && isOperator(line[i])) i++;
        pushTriple(start, i, S.OPERATOR);
        continue;
      }

      // --- Spread/rest ---
      if (ch === '.' && i + 2 < line.length && line[i + 1] === '.' && line[i + 2] === '.') {
        pushTriple(i, i + 3, S.OPERATOR);
        i += 3;
        continue;
      }

      // --- Everything else (punctuation, unknown) → gap, filled by packRunSpansInto ---
      i++;
    }

    writeOffset = packRunSpansInto(out, line.length, _syncBuf, _syncBufCount, writeOffset);
    out.spanLineStart[lineIdx + 1] = writeOffset;
  }
}
