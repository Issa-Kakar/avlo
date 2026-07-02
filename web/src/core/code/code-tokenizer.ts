/**
 * Code Tokenizer — the sync-floor highlighter. Char-code, allocation-free, kept
 * WYSIWYG-aligned with the Lezer worker's tag output so there is no color flip
 * when the parse arrives ~1 frame later.
 *
 * `syncTokenizeInto` is a thin **driver**: it writes the shared spans prologue
 * then dispatches by language to a per-language whole-source tokenizer. Today
 * JS/TS/Python all route to `tokenizeCLike` (they differ only by keyword table +
 * `isPython`). New structurally-distinct languages (JSON, SQL, HTML) slot in as
 * one `tokenizeXxx` + one dispatch arm — see the seam in `syncTokenizeInto`.
 *
 * Bundle hygiene (load-bearing): this file is imported ONLY by `code-system.ts`
 * and keeps `import type { CodeSource, CodeSpans }` type-only. `code-tokens.ts`
 * must never gain a *value* import of this file — the codec (`S`,
 * `ensureSpansLineCap`, `packRunSpansInto`) lives there so the lezer worker's
 * import graph stays free of `code-system.ts` (which pulls in RenderLoop →
 * image-manager → top-level `window`, crashing the worker on load).
 */

import type { CodeLanguage } from '../accessors';
import type { CodeSource, CodeSpans } from './code-system';
import { ensureSpansLineCap, packRunSpansInto, S } from './code-tokens';

// ============================================================================
// KEYWORD TABLES — length-bucketed, char-code-keyed, allocation-free classify
// ============================================================================
//
// Per-language `KwEntry[][]` indexed by identifier length. Each entry stores a
// Uint8Array of char codes, the final S to emit, and a `definesNext` flag —
// when true (function/class/def/type/interface/enum), the sync tokenizer's
// `lastDefIsFunc` state promotes the next identifier to S.FUNCTION_DEF
// (green). Tables built once at module load — no runtime cost.
//
// Reclassifications baked at table-build time so the sync tokenizer matches
// the lezer worker's tag-based output (no color flip on first parse arrival):
//   - true / false / null  (JS/TS) → S.NUMBER
//   - True / False / None  (Python) → S.NUMBER
//   - this / super         (JS/TS) → S.LANG_VAR (purple — Sweet Dracula's `variable.language`)
//   - self                 (Python) → S.LANG_VAR

interface KwEntry {
  codes: Uint8Array;
  style: S;
  definesNext: boolean;
}

interface KwSpec {
  word: string;
  style: S;
  definesNext?: boolean;
}

function buildKwTable(spec: readonly KwSpec[]): KwEntry[][] {
  const table: KwEntry[][] = [];
  for (const { word, style, definesNext } of spec) {
    const len = word.length;
    if (!table[len]) table[len] = [];
    const codes = new Uint8Array(len);
    for (let i = 0; i < len; i++) codes[i] = word.charCodeAt(i);
    table[len].push({ codes, style, definesNext: definesNext === true });
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
  // STORAGE (definer keywords — cyan); function/class promote next ident to FUNCTION_DEF
  { word: 'function', style: S.STORAGE, definesNext: true },
  { word: 'class', style: S.STORAGE, definesNext: true },
  { word: 'const', style: S.STORAGE },
  { word: 'let', style: S.STORAGE },
  { word: 'var', style: S.STORAGE },
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
  // LANG_VAR (purple — Sweet Dracula's `variable.language`)
  { word: 'this', style: S.LANG_VAR },
  { word: 'super', style: S.LANG_VAR },
]);

const TS_KW_BY_LEN: KwEntry[][] = buildKwTable([
  // KEYWORD — JS subset (with `enum` REMOVED here; reclassified as STORAGE for TS below)
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
  // STORAGE (definer keywords — cyan); function/class/type/interface/enum promote next ident to FUNCTION_DEF
  { word: 'function', style: S.STORAGE, definesNext: true },
  { word: 'class', style: S.STORAGE, definesNext: true },
  { word: 'const', style: S.STORAGE },
  { word: 'let', style: S.STORAGE },
  { word: 'var', style: S.STORAGE },
  { word: 'type', style: S.STORAGE, definesNext: true },
  { word: 'interface', style: S.STORAGE, definesNext: true },
  { word: 'enum', style: S.STORAGE, definesNext: true },
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
  // LANG_VAR (purple)
  { word: 'this', style: S.LANG_VAR },
  { word: 'super', style: S.LANG_VAR },
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
  // STORAGE (definer keywords — cyan); def/class promote next ident to FUNCTION_DEF
  { word: 'def', style: S.STORAGE, definesNext: true },
  { word: 'class', style: S.STORAGE, definesNext: true },
  { word: 'lambda', style: S.STORAGE },
  // MODIFIER
  { word: 'global', style: S.MODIFIER },
  { word: 'nonlocal', style: S.MODIFIER },
  { word: 'from', style: S.MODIFIER },
  { word: 'import', style: S.MODIFIER },
  // NUMBER (reclassified)
  { word: 'True', style: S.NUMBER },
  { word: 'False', style: S.NUMBER },
  { word: 'None', style: S.NUMBER },
  // LANG_VAR (purple)
  { word: 'self', style: S.LANG_VAR },
]);

function getKwTable(lang: CodeLanguage): KwEntry[][] {
  if (lang === 'python') return PY_KW_BY_LEN;
  if (lang === 'typescript') return TS_KW_BY_LEN;
  return JS_KW_BY_LEN;
}

/**
 * Linear scan of a length-bucket. Two char-code compares per candidate. No
 * string allocation. Returns the matched `KwEntry` (caller reads `.style` +
 * `.definesNext`) or `null` on miss. Monomorphic — every entry comes from one
 * factory (`buildKwTable`).
 */
function classifyIdent(text: string, start: number, end: number, table: KwEntry[][]): KwEntry | null {
  const len = end - start;
  const bucket = table[len];
  if (!bucket) return null;
  outer: for (let i = 0; i < bucket.length; i++) {
    const entry = bucket[i];
    const codes = entry.codes;
    for (let j = 0; j < len; j++) {
      if (text.charCodeAt(start + j) !== codes[j]) continue outer;
    }
    return entry;
  }
  return null;
}

// ============================================================================
// CHAR-CLASS HELPERS + SCAN ATOMS — char-code, stateless, allocation-free
// ============================================================================
//
// '0'-'9' = 48-57, 'a'-'z' = 97-122, 'A'-'Z' = 65-90, '_' = 95, '$' = 36.

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

// Reusable buffer for highlight triples — reset per line via counter. Required
// by the zero-alloc invariant: no per-line array/object allocation.
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

/** Scan a decimal (integer / fraction / exponent, `_` separators). Returns the end index. */
function scanDecimal(text: string, start: number, end: number): number {
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
  return i;
}

/**
 * Scan a numeric literal starting at `start` (a digit, or a `.` known to be
 * followed by a digit): hex / binary / octal / decimal / scientific, `_`
 * separators, trailing BigInt `n`. Returns the end index. Stateless — a future
 * language (SQL/JSON) can reuse this directly.
 */
function scanNumber(text: string, start: number, lineTo: number): number {
  let i = start;
  const cc = text.charCodeAt(i);
  if (cc === 48 && i + 1 < lineTo) {
    const next = text.charCodeAt(i + 1);
    if (next === 120 || next === 88) {
      // 0x / 0X
      i += 2;
      while (i < lineTo) {
        const c = text.charCodeAt(i);
        if (isHexDigit(c) || c === 95) i++;
        else break;
      }
    } else if (next === 98 || next === 66) {
      // 0b / 0B
      i += 2;
      while (i < lineTo) {
        const c = text.charCodeAt(i);
        if (c === 48 || c === 49 || c === 95) i++;
        else break;
      }
    } else if (next === 111 || next === 79) {
      // 0o / 0O
      i += 2;
      while (i < lineTo) {
        const c = text.charCodeAt(i);
        if ((c >= 48 && c <= 55) || c === 95) i++;
        else break;
      }
    } else {
      i = scanDecimal(text, i, lineTo);
    }
  } else {
    i = scanDecimal(text, i, lineTo);
  }
  // BigInt suffix
  if (i < lineTo && text.charCodeAt(i) === 110) i++;
  return i;
}

/**
 * Scan an escape sequence starting at backslash position. Returns absolute
 * position AFTER the escape sequence; callers clamp via
 * `Math.min(escEnd, lineTo)` on the pushTriple emit.
 *
 * Recognized forms:
 *   `\xHH`        — hex byte (up to 2 hex digits)
 *   `\uHHHH`      — unicode code point (up to 4 hex digits)
 *   `\u{...}`     — extended unicode (until closing brace)
 *   `\NNN`        — octal (1-3 digits; lang-dependent, tokenized uniformly)
 *   `\X`          — single-char escape (\\n, \\t, \\r, \\\\, \\', \\", \\`, ...)
 */
function scanEscape(text: string, escStart: number, lineTo: number): number {
  if (escStart + 1 >= lineTo) return lineTo;
  const next = text.charCodeAt(escStart + 1);
  // \xHH
  if (next === 120) {
    let end = escStart + 2;
    for (let k = 0; k < 2 && end < lineTo && isHexDigit(text.charCodeAt(end)); k++) end++;
    return end;
  }
  // \uHHHH or \u{...}
  if (next === 117) {
    if (escStart + 2 < lineTo && text.charCodeAt(escStart + 2) === 123) {
      let end = escStart + 3;
      while (end < lineTo && text.charCodeAt(end) !== 125) end++;
      if (end < lineTo) end++; // consume '}'
      return end;
    }
    let end = escStart + 2;
    for (let k = 0; k < 4 && end < lineTo && isHexDigit(text.charCodeAt(end)); k++) end++;
    return end;
  }
  // \NNN (octal, 1-3 digits)
  if (next >= 48 && next <= 55) {
    let end = escStart + 2;
    for (let k = 0; k < 2 && end < lineTo; k++) {
      const c = text.charCodeAt(end);
      if (c >= 48 && c <= 55) end++;
      else break;
    }
    return end;
  }
  // Single-char escape
  return escStart + 2;
}

/**
 * Scan a quoted string with escape-sequence splits. `runStart` is where the
 * STRING run begins (may include a prefix char like Python `f` before the
 * opening quote). `openQuotePos` is the position of the opening quote.
 *
 * Emits S.STRING for body chunks (including opening/closing quotes) and
 * S.OPERATOR for each escape sequence. Returns absolute position AFTER the
 * closing quote, or `lineTo` if unterminated on this line.
 */
function scanQuotedString(text: string, runStart: number, openQuotePos: number, lineTo: number, quoteCC: number, lineFrom: number): number {
  let i = openQuotePos + 1;
  let strStart = runStart;
  while (i < lineTo) {
    const c = text.charCodeAt(i);
    if (c === 92) {
      if (i > strStart) pushTriple(strStart - lineFrom, i - lineFrom, S.STRING);
      const escEnd = scanEscape(text, i, lineTo);
      const escClamp = escEnd < lineTo ? escEnd : lineTo;
      pushTriple(i - lineFrom, escClamp - lineFrom, S.OPERATOR);
      i = escEnd;
      strStart = i;
      continue;
    }
    if (c === quoteCC) {
      pushTriple(strStart - lineFrom, i + 1 - lineFrom, S.STRING);
      return i + 1;
    }
    i++;
  }
  if (lineTo > strStart) pushTriple(strStart - lineFrom, lineTo - lineFrom, S.STRING);
  return lineTo;
}

/**
 * Scan a Python triple-quoted string body with escape-sequence splits. Emits
 * S.STRING for body chunks and S.OPERATOR for each escape. Returns absolute
 * position AFTER the closing triple-quote if found within this line, otherwise
 * `-1` (caller marks `inTripleString` so the next line continuation resumes).
 *
 * `runStart` is where the STRING run begins (may include a prefix); `bodyStart`
 * is the position AFTER the opening triple (or the resumption position on a
 * continuation line — equal to `runStart` there).
 */
function scanTripleStringBody(
  text: string,
  runStart: number,
  bodyStart: number,
  lineTo: number,
  quoteCC: number,
  lineFrom: number,
): number {
  let i = bodyStart;
  let strStart = runStart;
  while (i < lineTo) {
    const c = text.charCodeAt(i);
    if (c === 92) {
      if (i > strStart) pushTriple(strStart - lineFrom, i - lineFrom, S.STRING);
      const escEnd = scanEscape(text, i, lineTo);
      const escClamp = escEnd < lineTo ? escEnd : lineTo;
      pushTriple(i - lineFrom, escClamp - lineFrom, S.OPERATOR);
      i = escEnd;
      strStart = i;
      continue;
    }
    if (c === quoteCC && i + 2 < lineTo && text.charCodeAt(i + 1) === quoteCC && text.charCodeAt(i + 2) === quoteCC) {
      pushTriple(strStart - lineFrom, i + 3 - lineFrom, S.STRING);
      return i + 3;
    }
    i++;
  }
  if (lineTo > strStart) pushTriple(strStart - lineFrom, lineTo - lineFrom, S.STRING);
  return -1;
}

/**
 * Scan a template literal body for `${}` expressions, escapes, and the closing
 * backtick. Pushes triples to `_syncBuf` line-relative to `lineFromAbs`.
 * Returns absolute end (after closing `) or -1 if unterminated on this line.
 */
function scanTemplateLiteral(text: string, start: number, lineTo: number, lineFromAbs: number): number {
  let i = start;
  let strStart = start;

  while (i < lineTo) {
    const cc = text.charCodeAt(i);
    if (cc === 92) {
      if (i > strStart) pushTriple(strStart - lineFromAbs, i - lineFromAbs, S.STRING);
      const escEnd = scanEscape(text, i, lineTo);
      const escClamp = escEnd < lineTo ? escEnd : lineTo;
      pushTriple(i - lineFromAbs, escClamp - lineFromAbs, S.OPERATOR);
      i = escEnd;
      strStart = i;
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

/** Pack the pooled `_syncBuf` triples for one line into `out`, write the next line's span start, return the new write offset. */
function flushLine(out: CodeSpans, lineLen: number, writeOffset: number, fullText: string, lineFrom: number, lineIdx: number): number {
  const next = packRunSpansInto(out, lineLen, _syncBuf, _syncBufCount, writeOffset, fullText, lineFrom);
  out.spanLineStart[lineIdx + 1] = next;
  return next;
}

// ============================================================================
// DRIVER — shared spans prologue + per-language dispatch (the seam)
// ============================================================================

/**
 * Sync tokenizer entry. Writes the shared spans prologue then dispatches by
 * `language` to a per-language whole-source tokenizer.
 *
 * JS/TS/Python are all C-like (they differ only by keyword table + `isPython`),
 * so they share `tokenizeCLike`. Structurally-distinct languages slot in here as
 * one tokenizer + one dispatch arm — the seam:
 *
 *   case 'json': tokenizeJson(source, out); return;   // strict minimal grammar
 *   case 'sql':  tokenizeSql(source, out);  return;   // case-insensitive kw + `--` comments
 *   case 'html': tokenizeHtml(source, out); return;   // markup state machine
 */
export function syncTokenizeInto(source: CodeSource, language: CodeLanguage, out: CodeSpans): void {
  ensureSpansLineCap(out, source.lineCount);
  out.lineCount = source.lineCount;
  out.spanLineStart[0] = 0;

  tokenizeCLike(source, language, out);
}

// ============================================================================
// C-LIKE TOKENIZER — JS / TS / Python
// ============================================================================
//
// Iterates `fullText` with absolute offsets; pushes line-relative triples to a
// pooled `_syncBuf`, then `flushLine` writes them into `out.spanData` with
// whitespace runs sentinelled to S.WHITESPACE.
//
// `lastSignificantChar` tracks the char code of the last emitted (non-ws,
// non-comment) char so `obj.foo` (lowercase ident after `.`, no `(` next)
// classifies as S.TYPE — matching the worker's tag-based classification.
//
// `lastDefIsFunc` is set true by a definer kw emit (function/class/def/type/
// interface/enum). The next identifier emit consumes it and renders as
// S.FUNCTION_DEF (green): `function foo`, `class Foo`, `type Bar`, `def baz`
// all turn green on the name. State persists across whitespace and comments
// (`function /* */ foo` resolves), reset by any other emit.
//
// Strings emit STRING runs with embedded escape sequences (`\X`, `\xHH`,
// `\uHHHH`, `\u{...}`, `\NNN`) split out as S.OPERATOR — pink escapes inside
// yellow strings, matching Sweet Dracula's TextMate scope.
//
// Out of scope (needs AST awareness): regex-delimiter split, JSX HTML/component
// tag split, parameter vs variable distinction, destructured aliases.
//
// All per-pass state lives as function-locals — no shared struct, monomorphic,
// zero-alloc.
function tokenizeCLike(source: CodeSource, language: CodeLanguage, out: CodeSpans): void {
  const kwTable = getKwTable(language);
  const isPython = language === 'python';
  const lineCount = source.lineCount;
  const fullText = source.fullText;
  const lineStart = source.lineStart;

  let writeOffset = 0;

  let inBlockComment = false;
  let inTemplateString = false;
  // Python triple-quoted string: 0 = not in, 34 = """, 39 = '''
  let inTripleString = 0;
  // Char code of last emitted non-whitespace, non-comment char. Drives
  // property-access classification (`obj.foo` → S.TYPE when prev sig char === '.').
  let lastSignificantChar = 0;
  // Set true after a definer kw (function/class/def/type/interface/enum) emit.
  // Consumed by the next identifier emit, which renders as S.FUNCTION_DEF
  // (green). Persists across whitespace + comments; reset by any other emit.
  let lastDefIsFunc = false;

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
          lastDefIsFunc = false;
        }
        continue;
      }

      // --- Python triple-quoted string continuation (cross-line) ---
      if (inTripleString !== 0) {
        const end = scanTripleStringBody(fullText, i, i, lineTo, inTripleString, lineFrom);
        if (end === -1) {
          i = lineTo;
        } else {
          i = end;
          lastSignificantChar = inTripleString;
          lastDefIsFunc = false;
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

      // --- Decorators (purple — Sweet Dracula's `meta.decorator`) ---
      if (cc === 64 && i + 1 < lineTo && isIdentStart(fullText.charCodeAt(i + 1))) {
        const start = i;
        i++;
        while (i < lineTo && isIdentPart(fullText.charCodeAt(i))) i++;
        pushTriple(start - lineFrom, i - lineFrom, S.LANG_VAR);
        lastSignificantChar = fullText.charCodeAt(i - 1);
        lastDefIsFunc = false;
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
          lastDefIsFunc = false;
          continue;
        }
        if (isPython && i + 2 < lineTo && fullText.charCodeAt(i + 1) === cc && fullText.charCodeAt(i + 2) === cc) {
          // Python triple-quoted — cross-line OK
          const end = scanTripleStringBody(fullText, i, i + 3, lineTo, cc, lineFrom);
          if (end === -1) {
            i = lineTo;
            inTripleString = cc;
          } else {
            i = end;
            lastSignificantChar = cc;
          }
          lastDefIsFunc = false;
          continue;
        }
        // Single/double quote — clamp to lineTo (newline terminates unterminated)
        i = scanQuotedString(fullText, i, i, lineTo, cc, lineFrom);
        lastSignificantChar = cc;
        lastDefIsFunc = false;
        continue;
      }

      // --- Numbers (hex, binary, octal, scientific, separators, BigInt) ---
      if (isDigit(cc) || (cc === 46 && i + 1 < lineTo && isDigit(fullText.charCodeAt(i + 1)))) {
        const start = i;
        i = scanNumber(fullText, i, lineTo);
        pushTriple(start - lineFrom, i - lineFrom, S.NUMBER);
        // Reset so the next '.' doesn't trip property-access TYPE classification
        // on `1.toString()` (belt-and-suspenders — `(` lookahead would catch it
        // anyway but a bare `1.foo` should not classify `foo` as TYPE).
        lastSignificantChar = 0;
        lastDefIsFunc = false;
        continue;
      }

      // --- Python string prefixes (f/r/b) ---
      if (isPython && (cc === 102 || cc === 114 || cc === 98 || cc === 70 || cc === 82 || cc === 66)) {
        const next = i + 1 < lineTo ? fullText.charCodeAt(i + 1) : 0;
        if (next === 34 || next === 39) {
          const start = i;
          const q = next;
          if (i + 3 < lineTo && fullText.charCodeAt(i + 2) === q && fullText.charCodeAt(i + 3) === q) {
            // Prefixed triple-quoted (e.g. f""")
            const end = scanTripleStringBody(fullText, start, i + 4, lineTo, q, lineFrom);
            if (end === -1) {
              i = lineTo;
              inTripleString = q;
            } else {
              i = end;
            }
          } else {
            i = scanQuotedString(fullText, start, i + 1, lineTo, q, lineFrom);
          }
          lastSignificantChar = q;
          lastDefIsFunc = false;
          continue;
        }
      }

      // --- Identifiers / keywords ---
      if (isIdentStart(cc)) {
        const start = i;
        i++;
        while (i < lineTo && isIdentPart(fullText.charCodeAt(i))) i++;

        // Emit + state update stays inline: the 6-way decision both reads AND
        // writes lastDefIsFunc / lastSignificantChar. Only the pure classify is
        // hoisted — hoisting the emit would risk a silent lost write-back.
        const kw = classifyIdent(fullText, start, i, kwTable);
        if (kw !== null) {
          pushTriple(start - lineFrom, i - lineFrom, kw.style);
          lastDefIsFunc = kw.definesNext;
        } else if (lastDefIsFunc) {
          // Preceding definer kw promotes this ident to FUNCTION_DEF (green)
          // — `function foo`, `class Foo`, `type Bar`, `def baz`, `interface I`.
          pushTriple(start - lineFrom, i - lineFrom, S.FUNCTION_DEF);
          lastDefIsFunc = false;
        } else if (i < lineTo && fullText.charCodeAt(i) === 40) {
          // Followed by `(` → function call (cyan)
          pushTriple(start - lineFrom, i - lineFrom, S.FUNCTION_CALL);
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
        lastDefIsFunc = false;
        continue;
      }

      // --- Spread/rest ---
      if (cc === 46 && i + 2 < lineTo && fullText.charCodeAt(i + 1) === 46 && fullText.charCodeAt(i + 2) === 46) {
        pushTriple(i - lineFrom, i + 3 - lineFrom, S.OPERATOR);
        i += 3;
        lastSignificantChar = 46;
        lastDefIsFunc = false;
        continue;
      }

      // --- Everything else (punctuation, unknown) → gap, filled by packRunSpansInto.
      //     Update lastSignificantChar so a trailing `.` enables property-access TYPE
      //     classification on the next ident. Comments and whitespace deliberately
      //     do NOT update it, so `obj /* */ . foo` still resolves `foo` as TYPE.
      lastSignificantChar = cc;
      lastDefIsFunc = false;
      i++;
    }

    writeOffset = flushLine(out, lineLen, writeOffset, fullText, lineFrom, lineIdx);
  }
}
