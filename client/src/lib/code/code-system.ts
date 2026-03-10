/**
 * Code System — Cache, Sync Tokenizer, Renderer, Worker Pool, CM Theme, Font Metrics
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
  type RunSpans,
  S,
  PALETTE,
  isBold,
  packRunSpans,
  CODE_BG,
  CODE_DEFAULT,
  CODE_GUTTER,
  CODE_SELECTION,
  CODE_LINE_HL,
  CODE_CARET,
  CODE_FONT_FAMILY,
  KEYWORD,
  DEF_KEYWORD,
  MODIFIER,
  STRING,
  NUMBER,
  COMMENT,
  FUNCTION,
  VARIABLE,
  TYPE,
  OPERATOR,
  ATTRIBUTE,
} from './code-shared';

// Re-export shared types/constants used by consumers
export type { RunSpans } from './code-shared';
export {
  S,
  PALETTE,
  isBold,
  packRunSpans,
  CODE_BG,
  CODE_DEFAULT,
  CODE_GUTTER,
  CODE_SELECTION,
  CODE_LINE_HL,
  CODE_CARET,
  CODE_FONT_FAMILY,
  KEYWORD,
  DEF_KEYWORD,
  MODIFIER,
  STRING,
  NUMBER,
  COMMENT,
  FUNCTION,
  VARIABLE,
  TYPE,
  OPERATOR,
  ATTRIBUTE,
  TAG_STYLES,
} from './code-shared';

// ============================================================================
// §1 CONSTANTS & FONT METRICS
// ============================================================================

// === Font ===
export const CHAR_WIDTH_RATIO = 0.6; // Fallback only — measured ratio preferred
export const LINE_HEIGHT_MULT = 1.5;
export const FONT_WEIGHT = 450;
export const FONT_WEIGHT_BOLD = 700;
export const CODE_FONT = `'${CODE_FONT_FAMILY}', monospace`;

// === Sizing ===
export const DEFAULT_FONT_SIZE = 14;
export const MIN_CHARS = 20;
export const DEFAULT_CHARS = 50;
export const BORDER_RADIUS = 12;

// === Proportional padding ratios ===
const PAD_TOP_RATIO = 1.5;
const PAD_BOTTOM_RATIO = 1.5;
const PAD_LEFT_RATIO = 0.85;
const PAD_RIGHT_RATIO = 0.85;
const GUTTER_PAD_RATIO = 2.0;

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

// === Measured font metrics (singleton lazy) ===
let _metrics: { charWidthRatio: number; baselineRatio: number } | null = null;

function measureCodeFontMetrics(): { charWidthRatio: number; baselineRatio: number } {
  if (_metrics) return _metrics;
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `${FONT_WEIGHT} 100px '${CODE_FONT_FAMILY}', monospace`;
    const charW = ctx.measureText('M').width / 100;
    const m = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
    const ascent = m.fontBoundingBoxAscent;
    const descent = m.fontBoundingBoxDescent;
    const lh = 100 * LINE_HEIGHT_MULT;
    const halfLeading = (lh - (ascent + descent)) / 2;
    _metrics = { charWidthRatio: charW, baselineRatio: (halfLeading + ascent) / lh };
  } catch {
    // SSR/worker fallback
    _metrics = { charWidthRatio: CHAR_WIDTH_RATIO, baselineRatio: 0.7 };
  }
  return _metrics;
}

// === Derived helpers ===

export function charWidth(fontSize: number): number {
  return fontSize * measureCodeFontMetrics().charWidthRatio;
}

export function lineHeight(fontSize: number): number {
  return fontSize * LINE_HEIGHT_MULT;
}

export function baselineOffset(fontSize: number): number {
  return lineHeight(fontSize) * measureCodeFontMetrics().baselineRatio;
}

export function gutterWidth(maxDigits: number, fontSize: number): number {
  return maxDigits * charWidth(fontSize);
}

export function contentLeft(maxDigits: number, fontSize: number): number {
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
// §2 TYPES
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
}

/** Compute total height from layout + fontSize — not stored. */
export function totalHeight(layout: CodeLayout, fontSize: number): number {
  return padTop(fontSize) + layout.lines.length * lineHeight(fontSize) + padBottom(fontSize);
}

// ============================================================================
// §3 SYNC TOKENIZER — outputs RunSpans[] (flat packed triples)
// ============================================================================

// Language keyword sets — sorted longest-first for greedy match
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

// Definition keywords → S.DEF_KW (yellow)
const jsDefKwSet = new Set(['function', 'class', 'const', 'let', 'var']);
const tsDefExtras = new Set(['type', 'interface', 'enum']);
const pyDefKwSet = new Set(['def', 'class', 'lambda']);

// Modifier / module keywords → S.MODIFIER (cyan)
const jsModifierSet = new Set(['export', 'import', 'from', 'default', 'async', 'static']);
const tsModifierExtras = new Set([
  'declare',
  'abstract',
  'readonly',
  'override',
  'private',
  'protected',
  'public',
  'namespace',
  'module',
]);
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

// Reusable buffer for highlight triples — reset per line via counter
let _syncBuf: number[] = [];
let _syncBufCount = 0;

function pushTriple(from: number, to: number, style: number): void {
  const idx = _syncBufCount * 3;
  if (idx + 2 >= _syncBuf.length) _syncBuf.length = idx + 30; // grow in chunks
  _syncBuf[idx] = from;
  _syncBuf[idx + 1] = to;
  _syncBuf[idx + 2] = style;
  _syncBufCount++;
}

/**
 * Sync regex tokenizer — returns RunSpans[] (one packed Uint16Array per source line).
 * Gaps between highlights are filled by packRunSpans with S.DEFAULT.
 */
export function syncTokenize(text: string, language: CodeLanguage): RunSpans[] {
  const lines = text.split('\n');
  const kwSet = getKeywordSet(language);
  const isPython = language === 'python';
  const result: RunSpans[] = new Array(lines.length);

  let inBlockComment = false;
  let inTemplateString = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
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
      if (
        lineIdx === 0 &&
        i === 0 &&
        ch === '#' &&
        i + 1 < line.length &&
        line[i + 1] === '!' &&
        !isPython
      ) {
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
      if (
        (ch >= '0' && ch <= '9') ||
        (ch === '.' && i + 1 < line.length && line[i + 1] >= '0' && line[i + 1] <= '9')
      ) {
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
      if (
        isPython &&
        (ch === 'f' || ch === 'r' || ch === 'b' || ch === 'F' || ch === 'R' || ch === 'B')
      ) {
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

      // --- Everything else (punctuation, unknown) → gap, filled by packRunSpans ---
      i++;
    }

    result[lineIdx] = packRunSpans(line.length, _syncBuf, _syncBufCount);
  }

  return result;
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

// ============================================================================
// §4 CACHE
// ============================================================================

interface CacheEntry {
  sourceLines: string[];
  version: number;
  spans: RunSpans[];
  layout: CodeLayout | null;
  layoutFontSize: number;
  layoutWidth: number;
  language: CodeLanguage;
  frame: FrameTuple | null;
}

class CodeSystemCache {
  private entries = new Map<string, CacheEntry>();

  getLayout(
    id: string,
    yText: Y.Text,
    fontSize: number,
    width: number,
    language: CodeLanguage,
  ): CodeLayout {
    let e = this.entries.get(id);

    // COLD MISS — build full entry from Y.Text
    if (!e) {
      const text = yText.toString();
      const sourceLines = text.split('\n');
      const spans = syncTokenize(text, language);
      const layout = this.computeLayout(sourceLines, fontSize, width);
      e = {
        sourceLines,
        version: 1,
        spans,
        layout,
        layoutFontSize: fontSize,
        layoutWidth: width,
        language,
        frame: null,
      };
      this.entries.set(id, e);
      requestParse(id, text, language, e.version);
      return layout;
    }

    // Language changed — re-tokenize spans only, keep layout if dims unchanged
    if (e.language !== language) {
      const text = e.sourceLines.join('\n');
      e.spans = syncTokenize(text, language);
      e.language = language;
      e.version++;
      requestParse(id, text, language, e.version);
      // Only recompute layout if fontSize/width also changed
      if (!e.layout || e.layoutFontSize !== fontSize || e.layoutWidth !== width) {
        e.layoutFontSize = fontSize;
        e.layoutWidth = width;
        e.frame = null;
        e.layout = this.computeLayout(e.sourceLines, fontSize, width);
      }
      return e.layout;
    }

    // Cached layout still valid?
    if (e.layout && e.layoutFontSize === fontSize && e.layoutWidth === width) {
      return e.layout;
    }

    // Relayout needed (fontSize or width changed)
    if (e.layoutFontSize !== fontSize || e.layoutWidth !== width) {
      e.layoutFontSize = fontSize;
      e.layoutWidth = width;
      e.frame = null;
    }
    e.layout = this.computeLayout(e.sourceLines, fontSize, width);
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
    const spans = syncTokenize(text, language);

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

  private computeLayout(sourceLines: string[], fontSize: number, width: number): CodeLayout {
    const sourceLineCount = sourceLines.length;
    const digits = Math.max(2, String(sourceLineCount).length);
    const cl = contentLeft(digits, fontSize);
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

    return { lines, sourceLineCount, totalWidth: width };
  }
}

// Singleton
export const codeSystem = new CodeSystemCache();

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
  );
  const [ox, oy] = props.origin;
  const th = totalHeight(layout, props.fontSize);
  const frame: FrameTuple = [ox, oy, layout.totalWidth, th];
  codeSystem.setFrame(id, frame);
  return [ox, oy, ox + layout.totalWidth, oy + th];
}

// ============================================================================
// §5 WORKER POOL — Warm, Persistent, Hash-Based Routing
// ============================================================================

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

/** Dispatch parse request to worker pool. */
export function requestParse(
  id: string,
  text: string,
  language: CodeLanguage,
  version: number,
  changes?: ChangedRange[],
): void {
  dispatch({ type: 'parse', id, text, language, version, changes });
}

/** Remove worker-side state for a deleted object. */
export function requestRemove(id: string): void {
  if (!workersReady) return;
  dispatch({ type: 'remove', id });
}

/** Clear all worker-side state (room change). */
export function requestClearAll(): void {
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

  return ranges;
}

// ============================================================================
// §7 CANVAS RENDERER — Zero-Allocation Span Iteration
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
): void {
  const lh = lineHeight(fontSize);
  const cw = charWidth(fontSize);
  const pt = padTop(fontSize);
  const pl = padLeft(fontSize);
  const gp = gutterPad(fontSize);
  const th = totalHeight(layout, fontSize);
  const digits = Math.max(2, String(layout.sourceLineCount).length);
  const gw = gutterWidth(digits, fontSize);
  const cl = pl + gw + gp;
  const normalFont = `${FONT_WEIGHT} ${fontSize}px ${CODE_FONT}`;
  const boldFont = `${FONT_WEIGHT_BOLD} ${fontSize}px ${CODE_FONT}`;

  ctx.save();

  // 1. Background
  ctx.fillStyle = CODE_BG;
  ctx.beginPath();
  ctx.roundRect(originX, originY, layout.totalWidth, th, BORDER_RADIUS);
  ctx.fill();

  // 2. Per visual line — alphabetic baseline from measured font metrics.
  ctx.textBaseline = 'alphabetic';
  const bl = baselineOffset(fontSize);
  let prevFont = '';

  for (let i = 0; i < layout.lines.length; i++) {
    const vline = layout.lines[i];
    const baseY = originY + pt + i * lh + bl;

    // 3. Gutter — only on first segment of source line
    if (vline.from === 0) {
      ctx.fillStyle = CODE_GUTTER;
      if (prevFont !== normalFont) {
        ctx.font = normalFont;
        prevFont = normalFont;
      }
      const lineNum = String(vline.srcIdx + 1);
      ctx.fillText(lineNum, originX + pl + (digits - lineNum.length) * cw, baseY);
    }

    // 4. Code text — iterate RunSpans with inline [vFrom, vTo) clipping
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

      // Set font/color
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

  ctx.restore();
}

// ============================================================================
// §8 CODEMIRROR THEME EXTENSIONS (exported for CodeTool)
// ============================================================================

let _themeExtensions: unknown[] | null = null;

export async function getCodeMirrorExtensions(): Promise<unknown[]> {
  if (_themeExtensions) return _themeExtensions;

  const [{ EditorView }, { syntaxHighlighting, HighlightStyle }, { tags }] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/language'),
    import('@lezer/highlight'),
  ]);

  const codeEditorTheme = EditorView.theme(
    {
      '&': {
        backgroundColor: CODE_BG,
        color: CODE_DEFAULT,
        borderRadius: 'inherit',
      },
      // All padding/sizing via CSS vars (--c-*) set as exact px by CodeTool
      // at mount and on every zoom change.  Avoids em→px browser conversion
      // which introduces sub-pixel rounding mismatches vs canvas rendering.
      // Vertical padding on .cm-scroller (not .cm-content) because CM's
      // viewState.measure() reads contentDOM padding with parseInt() which
      // truncates fractional px → gutter misalignment.
      '.cm-scroller': {
        lineHeight: `${LINE_HEIGHT_MULT}`,
        paddingTop: 'var(--c-pt)',
        paddingBottom: 'var(--c-pb)',
      },
      '.cm-gutters': {
        backgroundColor: CODE_BG,
        color: CODE_GUTTER,
        border: 'none',
        paddingLeft: 'var(--c-gl)',
        paddingRight: 'var(--c-gr)',
      },
      '.cm-content': {
        fontFamily: `'${CODE_FONT_FAMILY}', monospace`,
        padding: '0',
      },
      '.cm-line': {
        padding: '0 var(--c-pr) 0 0',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0',
        fontFamily: `'${CODE_FONT_FAMILY}', monospace`,
        fontFeatureSettings: '"tnum"',
        textAlign: 'right',
        minWidth: 'var(--c-gw)',
      },
      '.cm-cursor': { borderLeftColor: CODE_CARET },
      '.cm-activeLine': { backgroundColor: CODE_LINE_HL },
      '.cm-activeLineGutter': { backgroundColor: CODE_LINE_HL },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: CODE_SELECTION,
      },
      '.cm-matchingBracket': {
        backgroundColor: 'transparent',
        outline: `1px solid ${KEYWORD}80`,
        color: KEYWORD,
      },
      '.cm-nonmatchingBracket': {
        backgroundColor: 'transparent',
        outline: '1px solid #FF537080',
        color: '#FF5370',
      },
      '.cm-searchMatch': { backgroundColor: '#FFD43B40' },
      '.cm-tooltip': {
        backgroundColor: CODE_BG,
        color: CODE_DEFAULT,
        border: `1px solid ${CODE_SELECTION}`,
      },
      '.cm-foldPlaceholder': {
        backgroundColor: CODE_SELECTION,
        color: CODE_DEFAULT,
        border: 'none',
      },
    },
    { dark: true },
  );

  const codeHighlightStyle = syntaxHighlighting(
    HighlightStyle.define([
      // Control keywords
      {
        tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword],
        color: KEYWORD,
        fontWeight: 'bold',
      },
      // Definition keywords
      { tag: tags.definitionKeyword, color: DEF_KEYWORD, fontWeight: 'bold' },
      // Module keywords + modifiers
      { tag: [tags.moduleKeyword, tags.modifier], color: MODIFIER, fontWeight: 'bold' },
      // Strings
      {
        tag: [
          tags.string,
          tags.special(tags.string),
          tags.special(tags.brace),
          tags.escape,
          tags.regexp,
          tags.character,
        ],
        color: STRING,
      },
      // Numbers / atoms
      {
        tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom],
        color: NUMBER,
      },
      // Comments
      { tag: [tags.lineComment, tags.blockComment, tags.docComment], color: COMMENT },
      // Functions / class names / definitions
      {
        tag: [
          tags.function(tags.variableName),
          tags.function(tags.propertyName),
          tags.function(tags.definition(tags.variableName)),
        ],
        color: FUNCTION,
      },
      {
        tag: [tags.className, tags.definition(tags.propertyName), tags.definition(tags.typeName)],
        color: FUNCTION,
      },
      // Variables
      { tag: [tags.variableName, tags.self, tags.definition(tags.variableName)], color: VARIABLE },
      // Types / properties / tags
      {
        tag: [tags.typeName, tags.propertyName, tags.tagName, tags.angleBracket, tags.namespace],
        color: TYPE,
      },
      // Operators
      {
        tag: [
          tags.operator,
          tags.compareOperator,
          tags.logicOperator,
          tags.arithmeticOperator,
          tags.bitwiseOperator,
          tags.updateOperator,
          tags.definitionOperator,
          tags.typeOperator,
          tags.controlOperator,
        ],
        color: OPERATOR,
      },
      // Deref → default
      { tag: tags.derefOperator, color: CODE_DEFAULT },
      // Attributes (JSX/HTML)
      { tag: tags.attributeName, color: ATTRIBUTE },
      // Meta (decorators, hashbang)
      { tag: tags.meta, color: MODIFIER },
      // Punctuation / brackets
      {
        tag: [tags.separator, tags.bracket, tags.squareBracket, tags.paren, tags.brace],
        color: CODE_DEFAULT,
      },
      // Labels
      { tag: tags.labelName, color: VARIABLE },
      // Invalid
      { tag: tags.invalid, color: '#FF5370' },
    ]),
  );

  _themeExtensions = [codeEditorTheme, codeHighlightStyle];
  return _themeExtensions;
}
