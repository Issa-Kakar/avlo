/**
 * Code System — Cache, Sync Tokenizer, Renderer, Worker Pool, CM Theme, Font Metrics
 *
 * Two-tier tokenization: sync regex (floor) + Lezer worker (ceiling).
 * TextRun gap-fill model: every character belongs to exactly one run — no missing chars.
 * Proportional padding (fontSize-relative) + measured font metrics for pixel-perfect alignment.
 */

import type { BBoxTuple, FrameTuple } from '@avlo/shared';
import type { CodeLanguage } from '@avlo/shared';
import { getCodeProps } from '@avlo/shared';
import * as Y from 'yjs';
import { invalidateWorld } from '@/canvas/invalidation-helpers';
import { frameTupleToWorldBounds } from '@/lib/geometry/bounds';

import {
  type TextRun,
  type SparseHighlight,
  CODE_BG,
  CODE_DEFAULT,
  CODE_GUTTER,
  CODE_FONT_FAMILY,
  KEYWORD,
  STRING,
  NUMBER,
  COMMENT,
  FUNCTION,
  VARIABLE,
  TYPE,
  OPERATOR,
  highlightsToRuns,
  sliceRuns,
} from './code-shared';

// Re-export shared types/constants used by consumers
export type { TextRun, SparseHighlight } from './code-shared';
export {
  CODE_BG,
  CODE_DEFAULT,
  CODE_GUTTER,
  CODE_FONT_FAMILY,
  KEYWORD,
  STRING,
  NUMBER,
  COMMENT,
  FUNCTION,
  VARIABLE,
  TYPE,
  OPERATOR,
  TAG_STYLES,
  highlightsToRuns,
  sliceRuns,
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
export const DEFAULT_CHARS = 40;
export const BORDER_RADIUS = 8;

// === Proportional padding ratios ===
const PAD_TOP_RATIO = 1.5;
const PAD_BOTTOM_RATIO = 1.5;
const PAD_LEFT_RATIO = 0.85;
const PAD_RIGHT_RATIO = 0.85;
const GUTTER_PAD_RATIO = 0.7;

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
  return MIN_CHARS * cw + padLeft(fontSize) + padRight(fontSize) + gutterWidth(2, fontSize) + gutterPad(fontSize);
}

export function getDefaultWidth(fontSize: number): number {
  const cw = charWidth(fontSize);
  return DEFAULT_CHARS * cw + padLeft(fontSize) + padRight(fontSize) + gutterWidth(2, fontSize) + gutterPad(fontSize);
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
// §3 SYNC TOKENIZER — outputs SparseHighlight[][] (highlight emitter)
// ============================================================================

// Language keyword sets — sorted longest-first for greedy match
const JS_KEYWORDS = [
  'instanceof', 'continue', 'debugger', 'function', 'default', 'extends',
  'finally', 'delete', 'export', 'import', 'return', 'switch', 'typeof',
  'async', 'await', 'break', 'catch', 'class', 'const', 'false', 'super',
  'throw', 'while', 'yield', 'case', 'else', 'enum', 'from', 'null',
  'this', 'true', 'void', 'with', 'for', 'let', 'new', 'try', 'var',
  'if', 'in', 'of', 'do',
];

const TS_EXTRAS = [
  'implements', 'interface', 'namespace', 'protected', 'abstract', 'readonly',
  'override', 'private', 'declare', 'public', 'module', 'keyof', 'infer',
  'never', 'type', 'any', 'as', 'is',
];

const PY_KEYWORDS = [
  'continue', 'nonlocal', 'finally', 'lambda', 'global', 'assert', 'except',
  'import', 'return', 'False', 'raise', 'while', 'break', 'class', 'yield',
  'None', 'True', 'from', 'pass', 'with', 'elif', 'else', 'and', 'def',
  'del', 'for', 'not', 'try', 'as', 'if', 'in', 'is', 'or',
];

const jsKeywordSet = new Set(JS_KEYWORDS);
const tsKeywordSet = new Set([...JS_KEYWORDS, ...TS_EXTRAS]);
const pyKeywordSet = new Set(PY_KEYWORDS);

function getKeywordSet(lang: CodeLanguage): Set<string> {
  if (lang === 'python') return pyKeywordSet;
  if (lang === 'typescript') return tsKeywordSet;
  return jsKeywordSet;
}

/**
 * Sync regex tokenizer — highlight emitter. Returns SparseHighlight[][] per source line.
 * Gaps between highlights are filled by highlightsToRuns() with CODE_DEFAULT.
 */
export function syncTokenize(text: string, language: CodeLanguage): SparseHighlight[][] {
  const lines = text.split('\n');
  const kwSet = getKeywordSet(language);
  const isPython = language === 'python';
  const result: SparseHighlight[][] = [];

  let inBlockComment = false;
  let inTemplateString = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const highlights: SparseHighlight[] = [];
    let i = 0;

    while (i < line.length) {
      // --- Block comment continuation ---
      if (inBlockComment) {
        const end = line.indexOf('*/', i);
        if (end === -1) {
          highlights.push({ from: i, to: line.length, color: COMMENT, bold: false });
          i = line.length;
        } else {
          highlights.push({ from: i, to: end + 2, color: COMMENT, bold: false });
          i = end + 2;
          inBlockComment = false;
        }
        continue;
      }

      // --- Template string continuation ---
      if (inTemplateString) {
        const { end, highlights: tplHighlights } = scanTemplateLiteral(line, i);
        highlights.push(...tplHighlights);
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
      if (ch === ' ' || ch === '\t') { i++; continue; }

      // --- Hashbang on line 0 ---
      if (lineIdx === 0 && i === 0 && ch === '#' && i + 1 < line.length && line[i + 1] === '!' && !isPython) {
        highlights.push({ from: i, to: line.length, color: COMMENT, bold: false });
        i = line.length;
        continue;
      }

      // --- Line comments ---
      if (!isPython && ch === '/' && i + 1 < line.length) {
        if (line[i + 1] === '/') {
          highlights.push({ from: i, to: line.length, color: COMMENT, bold: false });
          i = line.length;
          continue;
        }
        if (line[i + 1] === '*') {
          const end = line.indexOf('*/', i + 2);
          if (end === -1) {
            highlights.push({ from: i, to: line.length, color: COMMENT, bold: false });
            i = line.length;
            inBlockComment = true;
          } else {
            highlights.push({ from: i, to: end + 2, color: COMMENT, bold: false });
            i = end + 2;
          }
          continue;
        }
      }
      if (isPython && ch === '#') {
        highlights.push({ from: i, to: line.length, color: COMMENT, bold: false });
        i = line.length;
        continue;
      }

      // --- Decorators ---
      if (ch === '@' && i + 1 < line.length && isIdentStart(line[i + 1])) {
        const start = i;
        i++; // skip @
        while (i < line.length && isIdentPart(line[i])) i++;
        highlights.push({ from: start, to: i, color: KEYWORD, bold: false });
        continue;
      }

      // --- Strings ---
      if (ch === '"' || ch === "'" || ch === '`') {
        // Python f-strings / r-strings handled via prefix check below
        if (ch === '`' && !isPython) {
          // Template literal with ${} expression support
          const { end, highlights: tplHighlights } = scanTemplateLiteral(line, i + 1);
          highlights.push({ from: i, to: i + 1, color: STRING, bold: false }); // opening `
          highlights.push(...tplHighlights);
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
            highlights.push({ from: i, to: line.length, color: STRING, bold: false });
            i = line.length;
          } else {
            highlights.push({ from: i, to: end + 3, color: STRING, bold: false });
            i = end + 3;
          }
          continue;
        }
        const end = findStringEnd(line, i + 1, ch);
        highlights.push({ from: i, to: end === -1 ? line.length : end + 1, color: STRING, bold: false });
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
        highlights.push({ from: start, to: i, color: NUMBER, bold: false });
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
              highlights.push({ from: start, to: line.length, color: STRING, bold: false });
              i = line.length;
            } else {
              highlights.push({ from: start, to: end + 3, color: STRING, bold: false });
              i = end + 3;
            }
          } else {
            const end = findStringEnd(line, i + 1, q);
            highlights.push({ from: start, to: end === -1 ? line.length : end + 1, color: STRING, bold: false });
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
          highlights.push({ from: start, to: i, color: KEYWORD, bold: true });
        } else if (i < line.length && line[i] === '(') {
          highlights.push({ from: start, to: i, color: FUNCTION, bold: false });
        } else if (word[0] >= 'A' && word[0] <= 'Z') {
          highlights.push({ from: start, to: i, color: TYPE, bold: false });
        } else {
          highlights.push({ from: start, to: i, color: VARIABLE, bold: false });
        }
        continue;
      }

      // --- Operators (including =>, ?., ??, ...) ---
      if (isOperator(ch)) {
        const start = i;
        i++;
        while (i < line.length && isOperator(line[i])) i++;
        highlights.push({ from: start, to: i, color: OPERATOR, bold: false });
        continue;
      }

      // --- Spread/rest ---
      if (ch === '.' && i + 2 < line.length && line[i + 1] === '.' && line[i + 2] === '.') {
        highlights.push({ from: i, to: i + 3, color: OPERATOR, bold: false });
        i += 3;
        continue;
      }

      // --- Everything else (punctuation, unknown) → gap, filled by highlightsToRuns ---
      i++;
    }

    result.push(highlights);
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

/** Scan a template literal body for ${} expressions. Returns end position (after closing `) or -1. */
function scanTemplateLiteral(
  line: string,
  start: number,
): { end: number; highlights: SparseHighlight[] } {
  const highlights: SparseHighlight[] = [];
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
        highlights.push({ from: strStart, to: i, color: STRING, bold: false });
      }
      highlights.push({ from: i, to: i + 1, color: STRING, bold: false }); // closing `
      return { end: i + 1, highlights };
    }
    if (line[i] === '$' && i + 1 < line.length && line[i + 1] === '{') {
      // String portion before ${
      if (i > strStart) {
        highlights.push({ from: strStart, to: i, color: STRING, bold: false });
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
    highlights.push({ from: strStart, to: line.length, color: STRING, bold: false });
  }
  return { end: -1, highlights };
}

function findStringEnd(line: string, start: number, quote: string): number {
  for (let i = start; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
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
  return ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '=' ||
    ch === '<' || ch === '>' || ch === '!' || ch === '&' || ch === '|' ||
    ch === '^' || ch === '~' || ch === '%' || ch === '?';
}

// ============================================================================
// §4 CACHE
// ============================================================================

interface CacheEntry {
  text: string;
  sourceLines: string[];
  version: number;
  runs: TextRun[][];
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
      const highlights = syncTokenize(text, language);
      const runs = sourceLines.map((line, i) => highlightsToRuns(line, highlights[i] ?? []));
      const layout = this.computeLayout(sourceLines, fontSize, width);
      e = {
        text, sourceLines, version: 1, runs, layout,
        layoutFontSize: fontSize, layoutWidth: width, language, frame: null,
      };
      this.entries.set(id, e);
      requestParse(id, text, language, e.version);
      return layout;
    }

    // Language changed — full rebuild
    if (e.language !== language) {
      const highlights = syncTokenize(e.text, language);
      e.runs = e.sourceLines.map((line, i) => highlightsToRuns(line, highlights[i] ?? []));
      e.layout = this.computeLayout(e.sourceLines, fontSize, width);
      e.layoutFontSize = fontSize;
      e.layoutWidth = width;
      e.language = language;
      e.version++;
      e.frame = null;
      requestParse(id, e.text, language, e.version);
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
   * Runs sync tokenizer → gap-fill → dispatches to Lezer worker.
   */
  handleContentChange(id: string, ev: Y.YTextEvent, language: CodeLanguage): void {
    const yText = ev.target as Y.Text;
    const text = yText.toString();
    const sourceLines = text.split('\n');
    const highlights = syncTokenize(text, language);
    const runs = sourceLines.map((line, i) => highlightsToRuns(line, highlights[i] ?? []));

    let e = this.entries.get(id);
    if (e) {
      e.text = text;
      e.sourceLines = sourceLines;
      e.version++;
      e.runs = runs;
      e.layout = null;
      e.frame = null;
    } else {
      e = {
        text, sourceLines, version: 1, runs,
        layout: null, layoutFontSize: 0, layoutWidth: 0, language, frame: null,
      };
      this.entries.set(id, e);
    }

    const changes = deltaToChangedRanges(
      ev.delta as { insert?: string | object; delete?: number; retain?: number }[],
    );
    requestParse(id, text, language, e.version, changes.length > 0 ? changes : undefined);
  }

  /**
   * Apply Lezer worker runs (ceiling upgrade). Version-gated to discard stale results.
   */
  applyWorkerRuns(id: string, runs: TextRun[][], forVersion: number): void {
    const e = this.entries.get(id);
    if (!e || forVersion !== e.version) return;
    e.runs = runs;
    // Layout dimensions unchanged — only colors differ. No layout null.
    // Trigger redraw if frame is known
    if (e.frame) {
      invalidateWorld(frameTupleToWorldBounds(e.frame));
    }
  }

  getRuns(id: string): TextRun[][] {
    return this.entries.get(id)?.runs ?? [];
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
      } else {
        for (let offset = 0; offset < text.length; offset += maxChars) {
          const segEnd = Math.min(offset + maxChars, text.length);
          lines.push({ srcIdx: i, from: offset, text: text.slice(offset, segEnd) });
        }
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
  const layout = codeSystem.getLayout(id, props.content, props.fontSize, props.width, props.language);
  const [ox, oy] = props.origin;
  const th = totalHeight(layout, props.fontSize);
  const frame: FrameTuple = [ox, oy, layout.totalWidth, th];
  codeSystem.setFrame(id, frame);
  return [ox, oy, ox + layout.totalWidth, oy + th];
}

// ============================================================================
// §5 WORKER POOL — Warm, Persistent, Round-Robin
// ============================================================================

export interface ChangedRange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

type WorkerRequest =
  | { type: 'parse'; id: string; text: string; language: CodeLanguage; version: number; changes?: ChangedRange[] }
  | { type: 'remove'; id: string }
  | { type: 'clearAll' };

interface WorkerResponse {
  type: 'runs';
  id: string;
  version: number;
  runs: TextRun[][];
}

const POOL_SIZE = 2;
const workers: Worker[] = [];
let nextWorker = 0;
let workersReady = false;

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
  workers[nextWorker].postMessage(msg);
  nextWorker = (nextWorker + 1) % POOL_SIZE;
}

function handleWorkerMessage(e: MessageEvent<WorkerResponse>): void {
  const { id, version, runs } = e.data;
  codeSystem.applyWorkerRuns(id, runs, version);
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
// §7 CANVAS RENDERER
// ============================================================================

/**
 * Render a code layout onto the canvas using TextRun[] gap-filled model.
 * Every character in every run — no missing chars.
 */
export function renderCodeLayout(
  ctx: CanvasRenderingContext2D,
  layout: CodeLayout,
  originX: number,
  originY: number,
  fontSize: number,
  runs: TextRun[][],
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
      if (prevFont !== normalFont) { ctx.font = normalFont; prevFont = normalFont; }
      const lineNum = String(vline.srcIdx + 1);
      ctx.fillText(lineNum, originX + pl + (digits - lineNum.length) * cw, baseY);
    }

    // 4. Code text — iterate sliced runs, advance x cursor
    const lineRuns = runs[vline.srcIdx];
    if (!lineRuns) continue;
    const sliced = vline.from === 0 && vline.text.length === (layout.lines[i + 1]?.srcIdx === vline.srcIdx ? -1 : -1)
      ? lineRuns // Optimization: if full line and no wrap, use runs directly
      : sliceRuns(lineRuns, vline.from, vline.from + vline.text.length);

    let x = originX + cl;
    for (const run of sliced) {
      if (run.text.length === 0) continue;
      // Batch font/color changes
      const font = run.bold ? boldFont : normalFont;
      if (prevFont !== font) { ctx.font = font; prevFont = font; }
      ctx.fillStyle = run.color;
      // Only fillText for non-whitespace (whitespace is invisible anyway)
      if (!/^\s+$/.test(run.text)) {
        ctx.fillText(run.text, x, baseY);
      }
      x += run.text.length * cw;
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

  const metrics = measureCodeFontMetrics();
  const cwRatio = metrics.charWidthRatio;

  const codeEditorTheme = EditorView.theme(
    {
      '&': {
        backgroundColor: CODE_BG,
        color: CODE_DEFAULT,
        borderRadius: 'inherit',
      },
      '.cm-scroller': {
        lineHeight: `${LINE_HEIGHT_MULT}`,
        // Vertical padding lives here — NOT on .cm-content — because CM's
        // viewState.measure() reads contentDOM padding with parseInt() which
        // truncates fractional px.  That truncated value feeds documentPadding
        // → gutter marginTop, while CSS keeps the full float → gutter sits
        // above content by the truncated fraction.  Padding on .cm-scroller
        // avoids this entirely: documentPadding.top = 0 (integer), gutters
        // and content are both pushed down equally by the scroller padding.
        paddingTop: `${PAD_TOP_RATIO}em`,
        paddingBottom: `${PAD_BOTTOM_RATIO}em`,
      },
      '.cm-gutters': {
        backgroundColor: CODE_BG,
        color: CODE_GUTTER,
        border: 'none',
        paddingLeft: `${PAD_LEFT_RATIO}em`,
        paddingRight: `${GUTTER_PAD_RATIO}em`,
      },
      '.cm-content': {
        fontFamily: `'${CODE_FONT_FAMILY}', monospace`,
        padding: '0', // Override base theme's 4px 0 — see .cm-scroller comment
        overflowWrap: 'break-word',
        wordBreak: 'break-all',
        textRendering: 'geometricPrecision',
      },
      '.cm-line': {
        padding: `0 ${PAD_RIGHT_RATIO}em 0 0`,
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0',
        fontFamily: `'${CODE_FONT_FAMILY}', monospace`,
        fontFeatureSettings: '"tnum"',
        textAlign: 'right',
        minWidth: `${2 * cwRatio}em`,
      },
      '.cm-cursor': { borderLeftColor: '#528bff' },
      '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: '#3e4451',
      },
    },
    { dark: true },
  );

  const codeHighlightStyle = syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.keyword, color: KEYWORD, fontWeight: 'bold' },
      { tag: tags.string, color: STRING },
      { tag: [tags.special(tags.string)], color: STRING },
      { tag: tags.escape, color: STRING },
      { tag: tags.number, color: NUMBER },
      { tag: [tags.lineComment, tags.blockComment], color: COMMENT },
      { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: FUNCTION },
      { tag: tags.variableName, color: VARIABLE },
      { tag: [tags.typeName, tags.className], color: TYPE },
      { tag: [tags.operator, tags.compareOperator, tags.logicOperator], color: OPERATOR },
      { tag: tags.propertyName, color: VARIABLE },
      { tag: tags.bool, color: NUMBER },
      { tag: tags.null, color: NUMBER },
      { tag: tags.self, color: KEYWORD },
      { tag: tags.atom, color: NUMBER },
      { tag: tags.meta, color: KEYWORD },
      { tag: [tags.regexp], color: STRING },
      { tag: tags.definition(tags.variableName), color: VARIABLE },
    ]),
  );

  _themeExtensions = [codeEditorTheme, codeHighlightStyle];
  return _themeExtensions;
}
