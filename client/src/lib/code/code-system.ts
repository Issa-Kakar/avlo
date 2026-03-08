/**
 * Code System — Constants, Types, Theme, Cache, Renderer, Worker Communication
 *
 * Single module replacing code-constants, code-layout-cache, code-renderer.
 * Organized by data flow. Worker stays separate as lezer-worker.ts.
 *
 * Two-tier tokenization: sync regex (floor) + Lezer worker (ceiling).
 * Sync tokenizer runs on main thread inside handleContentChange — gives instant
 * correct-ish colors. Lezer worker provides full accuracy and swaps in when ready.
 * Tokens are NEVER null after first content — no default-color flicker.
 */

import type { FrameTuple } from '@avlo/shared';
import type { CodeLanguage } from '@avlo/shared';
import * as Y from 'yjs';

// ============================================================================
// §1 CONSTANTS
// ============================================================================

// === Font ===
export const CHAR_WIDTH_RATIO = 0.6;
export const LINE_HEIGHT_MULT = 1.5;
export const FONT_WEIGHT = 400;
export const FONT_WEIGHT_BOLD = 700;
export const CODE_FONT = '"JetBrains Mono", monospace';

// === Sizing ===
export const DEFAULT_FONT_SIZE = 14;
export const MIN_CHARS = 24;
export const DEFAULT_CHARS = 60;
export const PADDING_TOP = 12;
export const PADDING_BOTTOM = 12;
export const PADDING_LEFT = 8;
export const PADDING_RIGHT = 12;
export const GUTTER_PAD_RIGHT = 10;
export const BORDER_RADIUS = 8;

// === Dark theme palette (One Dark inspired) ===
export const CODE_BG = '#282c34';
export const CODE_DEFAULT = '#abb2bf';
export const CODE_GUTTER = '#636d83';

// === Token colors (One Dark) ===
export const KEYWORD = '#c678dd';
export const STRING = '#98c379';
export const NUMBER = '#d19a66';
export const COMMENT = '#5c6370';
export const FUNCTION = '#61afef';
export const VARIABLE = '#e06c75';
export const TYPE = '#e5c07b';
export const OPERATOR = '#56b6c2';

// === Derived helpers ===

export function charWidth(fontSize: number): number {
  return fontSize * CHAR_WIDTH_RATIO;
}

export function lineHeight(fontSize: number): number {
  return fontSize * LINE_HEIGHT_MULT;
}

export function gutterWidth(maxDigits: number, fontSize: number): number {
  return maxDigits * charWidth(fontSize);
}

export function contentLeft(maxDigits: number, fontSize: number): number {
  return PADDING_LEFT + gutterWidth(maxDigits, fontSize) + GUTTER_PAD_RIGHT;
}

export function getMinWidth(fontSize: number): number {
  const cw = charWidth(fontSize);
  return (
    MIN_CHARS * cw + PADDING_LEFT + PADDING_RIGHT + gutterWidth(2, fontSize) + GUTTER_PAD_RIGHT
  );
}

export function getDefaultWidth(fontSize: number): number {
  const cw = charWidth(fontSize);
  return (
    DEFAULT_CHARS * cw + PADDING_LEFT + PADDING_RIGHT + gutterWidth(2, fontSize) + GUTTER_PAD_RIGHT
  );
}

// ============================================================================
// §2 TYPES
// ============================================================================

export interface CodeToken {
  from: number;
  to: number;
  color: string;
  bold?: boolean;
  italic?: boolean;
}

export interface CodeLayoutLine {
  index: number;
  text: string;
  tokens: CodeToken[];
}

export interface CodeLayout {
  lines: CodeLayoutLine[];
  fontSize: number;
  lineHeight: number;
  charWidth: number;
  gutterDigits: number;
  gutterWidth: number;
  contentLeft: number;
  totalHeight: number;
  totalWidth: number;
}

/**
 * TAG_STYLES map — used by both worker (token extraction) and CodeMirror theme
 * for WYSIWYG parity between canvas and DOM editor.
 */
export const TAG_STYLES: Record<string, { color: string; bold?: boolean }> = {
  keyword: { color: KEYWORD, bold: true },
  string: { color: STRING },
  number: { color: NUMBER },
  comment: { color: COMMENT },
  function: { color: FUNCTION },
  variable: { color: VARIABLE },
  type: { color: TYPE },
  operator: { color: OPERATOR },
  punctuation: { color: CODE_DEFAULT },
};

// ============================================================================
// §3 SYNC REGEX TOKENIZER (floor)
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

// Build keyword sets for O(1) lookup
const jsKeywordSet = new Set(JS_KEYWORDS);
const tsKeywordSet = new Set([...JS_KEYWORDS, ...TS_EXTRAS]);
const pyKeywordSet = new Set(PY_KEYWORDS);

function getKeywordSet(lang: CodeLanguage): Set<string> {
  if (lang === 'python') return pyKeywordSet;
  if (lang === 'typescript') return tsKeywordSet;
  return jsKeywordSet;
}

/**
 * Sync regex tokenizer — runs on main thread, ~30-50μs for typical files.
 * Handles: keywords, strings, numbers, comments, operators, punctuation.
 * Returns per-line token arrays (floor accuracy, instant).
 *
 * Uses sorted-longest-first keyword lists + a single-pass state machine
 * for comments/strings that span across lines.
 */
export function syncTokenize(text: string, language: CodeLanguage): CodeToken[][] {
  const lines = text.split('\n');
  const kwSet = getKeywordSet(language);
  const isPython = language === 'python';
  const result: CodeToken[][] = [];

  // Cross-line state
  let inBlockComment = false;
  let inTemplateString = false; // JS/TS backtick

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const tokens: CodeToken[] = [];
    let i = 0;

    while (i < line.length) {
      // --- Block comment continuation ---
      if (inBlockComment) {
        const end = line.indexOf('*/', i);
        if (end === -1) {
          tokens.push({ from: i, to: line.length, color: COMMENT });
          i = line.length;
        } else {
          tokens.push({ from: i, to: end + 2, color: COMMENT });
          i = end + 2;
          inBlockComment = false;
        }
        continue;
      }

      // --- Template string continuation ---
      if (inTemplateString) {
        const end = line.indexOf('`', i);
        if (end === -1) {
          tokens.push({ from: i, to: line.length, color: STRING });
          i = line.length;
        } else {
          tokens.push({ from: i, to: end + 1, color: STRING });
          i = end + 1;
          inTemplateString = false;
        }
        continue;
      }

      const ch = line[i];

      // --- Whitespace: skip ---
      if (ch === ' ' || ch === '\t') {
        i++;
        continue;
      }

      // --- Line comments ---
      if (!isPython && ch === '/' && i + 1 < line.length) {
        if (line[i + 1] === '/') {
          tokens.push({ from: i, to: line.length, color: COMMENT });
          i = line.length;
          continue;
        }
        if (line[i + 1] === '*') {
          const end = line.indexOf('*/', i + 2);
          if (end === -1) {
            tokens.push({ from: i, to: line.length, color: COMMENT });
            i = line.length;
            inBlockComment = true;
          } else {
            tokens.push({ from: i, to: end + 2, color: COMMENT });
            i = end + 2;
          }
          continue;
        }
      }
      if (isPython && ch === '#') {
        tokens.push({ from: i, to: line.length, color: COMMENT });
        i = line.length;
        continue;
      }

      // --- Strings ---
      if (ch === '"' || ch === "'" || ch === '`') {
        if (ch === '`' && !isPython) {
          // Template literal — may span lines
          const end = findStringEnd(line, i + 1, '`');
          if (end === -1) {
            tokens.push({ from: i, to: line.length, color: STRING });
            i = line.length;
            inTemplateString = true;
          } else {
            tokens.push({ from: i, to: end + 1, color: STRING });
            i = end + 1;
          }
          continue;
        }
        // Python triple quotes
        if (isPython && i + 2 < line.length && line[i + 1] === ch && line[i + 2] === ch) {
          const closeSeq = ch + ch + ch;
          const end = line.indexOf(closeSeq, i + 3);
          if (end === -1) {
            tokens.push({ from: i, to: line.length, color: STRING });
            i = line.length;
            // Note: cross-line triple-quote tracking omitted for simplicity
            // (floor accuracy — Lezer worker handles it correctly)
          } else {
            tokens.push({ from: i, to: end + 3, color: STRING });
            i = end + 3;
          }
          continue;
        }
        const end = findStringEnd(line, i + 1, ch);
        tokens.push({ from: i, to: end === -1 ? line.length : end + 1, color: STRING });
        i = end === -1 ? line.length : end + 1;
        continue;
      }

      // --- Numbers ---
      if (
        (ch >= '0' && ch <= '9') ||
        (ch === '.' && i + 1 < line.length && line[i + 1] >= '0' && line[i + 1] <= '9')
      ) {
        const start = i;
        if (ch === '0' && i + 1 < line.length && (line[i + 1] === 'x' || line[i + 1] === 'X')) {
          i += 2;
          while (i < line.length && isHexDigit(line[i])) i++;
        } else {
          while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
          if (i < line.length && line[i] === '.') {
            i++;
            while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
          }
          if (i < line.length && (line[i] === 'e' || line[i] === 'E')) {
            i++;
            if (i < line.length && (line[i] === '+' || line[i] === '-')) i++;
            while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
          }
        }
        tokens.push({ from: start, to: i, color: NUMBER });
        continue;
      }

      // --- Identifiers / keywords ---
      if (isIdentStart(ch)) {
        const start = i;
        i++;
        while (i < line.length && isIdentPart(line[i])) i++;
        const word = line.slice(start, i);

        if (kwSet.has(word)) {
          tokens.push({ from: start, to: i, color: KEYWORD, bold: true });
        } else if (i < line.length && line[i] === '(') {
          tokens.push({ from: start, to: i, color: FUNCTION });
        } else if (word[0] >= 'A' && word[0] <= 'Z') {
          tokens.push({ from: start, to: i, color: TYPE });
        } else {
          tokens.push({ from: start, to: i, color: VARIABLE });
        }
        continue;
      }

      // --- Operators ---
      if (isOperator(ch)) {
        const start = i;
        i++;
        // Consume multi-char operators
        while (i < line.length && isOperator(line[i])) i++;
        tokens.push({ from: start, to: i, color: OPERATOR });
        continue;
      }

      // --- Punctuation (braces, parens, brackets, semicolons, commas, dots) ---
      if (isPunctuation(ch)) {
        tokens.push({ from: i, to: i + 1, color: CODE_DEFAULT });
        i++;
        continue;
      }

      // --- Fallback: skip unknown char ---
      i++;
    }

    result.push(tokens);
  }

  return result;
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

function isPunctuation(ch: string): boolean {
  return (
    ch === '(' ||
    ch === ')' ||
    ch === '{' ||
    ch === '}' ||
    ch === '[' ||
    ch === ']' ||
    ch === ';' ||
    ch === ',' ||
    ch === '.' ||
    ch === ':' ||
    ch === '@'
  );
}

// ============================================================================
// §4 CACHE
// ============================================================================

interface CacheEntry {
  text: string;
  lines: string[];
  tokens: CodeToken[][] | null; // null only before first content
  layout: CodeLayout | null;
  layoutFontSize: number;
  layoutWidth: number;
  frame: FrameTuple | null;
}

class CodeSystemCache {
  private entries = new Map<string, CacheEntry>();

  private getOrCreate(id: string): CacheEntry {
    let e = this.entries.get(id);
    if (!e) {
      e = {
        text: '',
        lines: [''],
        tokens: null,
        layout: null,
        layoutFontSize: 0,
        layoutWidth: 0,
        frame: null,
      };
      this.entries.set(id, e);
    }
    return e;
  }

  getLayout(
    id: string,
    yText: Y.Text,
    fontSize: number,
    width: number,
    _language: CodeLanguage,
  ): CodeLayout {
    const e = this.getOrCreate(id);

    // Re-read text if cache is empty (first access before observer fired)
    if (e.text === '' && !e.tokens) {
      e.text = yText.toString();
      e.lines = e.text.split('\n');
      e.layout = null;
      e.frame = null;
    }

    // Re-layout if fontSize or width changed
    if (e.layoutFontSize !== fontSize || e.layoutWidth !== width) {
      e.layout = null;
      e.frame = null;
      e.layoutFontSize = fontSize;
      e.layoutWidth = width;
    }

    if (e.layout) return e.layout;

    const lines = e.lines;
    const tokens = e.tokens;
    const cw = charWidth(fontSize);
    const lh = lineHeight(fontSize);
    const digits = Math.max(2, String(lines.length).length);
    const gw = gutterWidth(digits, fontSize);
    const cl = contentLeft(digits, fontSize);

    const layoutLines: CodeLayoutLine[] = lines.map((text, i) => ({
      index: i,
      text,
      tokens: tokens?.[i] ?? [],
    }));

    const totalHeight = PADDING_TOP + lines.length * lh + PADDING_BOTTOM;

    e.layout = {
      lines: layoutLines,
      fontSize,
      lineHeight: lh,
      charWidth: cw,
      gutterDigits: digits,
      gutterWidth: gw,
      contentLeft: cl,
      totalHeight,
      totalWidth: width,
    };

    return e.layout;
  }

  /**
   * Called synchronously from deep observer on Y.Text change.
   * Runs sync regex tokenizer immediately — tokens are NEVER null after this.
   */
  handleContentChange(id: string, text: string, lines: string[], language: CodeLanguage): void {
    const e = this.getOrCreate(id);
    e.text = text;
    e.lines = lines;
    e.tokens = syncTokenize(text, language);
    e.layout = null;
    e.frame = null;
  }

  /**
   * Apply Lezer worker parse results (ceiling upgrade).
   * NO invalidateWorld — the dirty rect from the observer already covers this.
   */
  applyTokens(id: string, tokens: CodeToken[][]): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.tokens = tokens;
    e.layout = null; // Force re-layout to pick up new tokens
    // Note: frame is NOT nulled — dimensions don't change from token colors
  }

  setFrame(id: string, frame: FrameTuple): void {
    this.getOrCreate(id).frame = frame;
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

/** Get derived frame for a code object. Mirrors getTextFrame() pattern. */
export function getCodeFrame(id: string): FrameTuple | null {
  return codeSystem.getFrame(id);
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
  | { type: 'parse'; id: string; text: string; language: CodeLanguage; changes?: ChangedRange[] }
  | { type: 'remove'; id: string }
  | { type: 'clearAll' };

interface WorkerResponse {
  type: 'tokens';
  id: string;
  tokens: CodeToken[][];
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
  const { id, tokens } = e.data;
  codeSystem.applyTokens(id, tokens);
}

/** Dispatch parse request to worker pool. */
export function requestParse(
  id: string,
  text: string,
  language: CodeLanguage,
  changes?: ChangedRange[],
): void {
  dispatch({ type: 'parse', id, text, language, changes });
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
 * Dual position tracking: posOld (pre-edit) and posNew (post-edit).
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
 * Render a code layout onto the canvas.
 * @param originX - Top-left X in world coords
 * @param originY - Top-left Y in world coords
 */
export function renderCodeLayout(
  ctx: CanvasRenderingContext2D,
  layout: CodeLayout,
  originX: number,
  originY: number,
): void {
  const {
    lines,
    fontSize,
    lineHeight: lh,
    charWidth: cw,
    gutterDigits,
    contentLeft: cl,
    totalHeight,
    totalWidth,
  } = layout;

  ctx.save();

  // 1. Background
  ctx.fillStyle = CODE_BG;
  ctx.beginPath();
  ctx.roundRect(originX, originY, totalWidth, totalHeight, BORDER_RADIUS);
  ctx.fill();

  // 2. Clip to background bounds
  ctx.beginPath();
  ctx.roundRect(originX, originY, totalWidth, totalHeight, BORDER_RADIUS);
  ctx.clip();

  // 3. Set font
  ctx.textBaseline = 'alphabetic';
  const baselineOffset = lh * 0.7;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const baseY = originY + PADDING_TOP + i * lh + baselineOffset;

    // 4. Gutter (right-aligned line numbers)
    ctx.fillStyle = CODE_GUTTER;
    ctx.font = `${FONT_WEIGHT} ${fontSize}px ${CODE_FONT}`;
    const lineNum = String(i + 1);
    const gutterX = originX + PADDING_LEFT + (gutterDigits - lineNum.length) * cw;
    ctx.fillText(lineNum, gutterX, baseY);

    // 5. Code text
    const codeX = originX + cl;

    if (line.tokens.length > 0) {
      for (const token of line.tokens) {
        const text = line.text.slice(token.from, token.to);
        if (!text) continue;
        ctx.fillStyle = token.color;
        if (token.bold) {
          ctx.font = `700 ${fontSize}px ${CODE_FONT}`;
        } else {
          ctx.font = `${FONT_WEIGHT} ${fontSize}px ${CODE_FONT}`;
        }
        ctx.fillText(text, codeX + token.from * cw, baseY);
      }
    } else {
      ctx.fillStyle = CODE_DEFAULT;
      ctx.font = `${FONT_WEIGHT} ${fontSize}px ${CODE_FONT}`;
      ctx.fillText(line.text, codeX, baseY);
    }
  }

  ctx.restore();
}

// ============================================================================
// §8 CODEMIRROR THEME EXTENSIONS (exported for CodeTool)
// ============================================================================

// Lazy-loaded to avoid importing CodeMirror at module level.
// CodeTool calls getCodeMirrorExtensions() when mounting an editor.

let _themeExtensions: unknown[] | null = null;

export async function getCodeMirrorExtensions(): Promise<unknown[]> {
  if (_themeExtensions) return _themeExtensions;

  const [{ EditorView }, { syntaxHighlighting, HighlightStyle }, { tags }] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/language'),
    import('@lezer/highlight'),
  ]);

  const codeEditorTheme = EditorView.theme({
    '&': {
      backgroundColor: CODE_BG,
      color: CODE_DEFAULT,
      borderRadius: `${BORDER_RADIUS}px`,
    },
    '.cm-gutters': {
      backgroundColor: CODE_BG,
      color: CODE_GUTTER,
      border: 'none',
      paddingRight: `${GUTTER_PAD_RIGHT}px`,
    },
    '.cm-content': {
      fontFamily: CODE_FONT,
      padding: `${PADDING_TOP}px 0 ${PADDING_BOTTOM}px 0`,
    },
    '.cm-line': {
      padding: `0 ${PADDING_RIGHT}px 0 0`,
    },
    '.cm-cursor': { borderLeftColor: '#528bff' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: '#3e4451',
    },
  });

  const codeHighlightStyle = syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.keyword, color: KEYWORD, fontWeight: 'bold' },
      { tag: tags.string, color: STRING },
      { tag: tags.number, color: NUMBER },
      { tag: [tags.lineComment, tags.blockComment], color: COMMENT },
      {
        tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
        color: FUNCTION,
      },
      { tag: tags.variableName, color: VARIABLE },
      { tag: [tags.typeName, tags.className], color: TYPE },
      { tag: [tags.operator, tags.compareOperator, tags.logicOperator], color: OPERATOR },
      { tag: tags.propertyName, color: VARIABLE },
      { tag: tags.bool, color: NUMBER },
      { tag: tags.null, color: NUMBER },
      { tag: [tags.regexp], color: STRING },
      { tag: tags.definition(tags.variableName), color: VARIABLE },
    ]),
  );

  _themeExtensions = [codeEditorTheme, codeHighlightStyle];
  return _themeExtensions;
}
