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
// Pure string constants (zero imports) — shared with the vendored worker
// tokenizer so both sides classify from the same word list. Never import
// `vendor/sql/tokens.ts` here: it would drag @lezer/lr into the main bundle.
import { SQL_KEYWORDS, SQL_TYPES } from './vendor/sql/keywords';

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
  // STORAGE (definer keywords — cyan; `extends` is definitionKeyword in Lezer);
  // function/class promote next ident to FUNCTION_DEF
  { word: 'function', style: S.STORAGE, definesNext: true },
  { word: 'class', style: S.STORAGE, definesNext: true },
  { word: 'extends', style: S.STORAGE },
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
  // STORAGE (definer keywords — cyan; `extends` is definitionKeyword in Lezer);
  // function/class/type/interface/enum promote next ident to FUNCTION_DEF
  { word: 'function', style: S.STORAGE, definesNext: true },
  { word: 'class', style: S.STORAGE, definesNext: true },
  { word: 'extends', style: S.STORAGE },
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
  // NOTE: `self` deliberately absent — @lezer/python tags it as a plain
  // VariableName (fg), so baking LANG_VAR here would flash purple→fg on
  // every parse arrival.
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
      // ${ … } — the delimiters are InterpolationStart/End → special(brace) →
      // STRING (yellow); the expression body stays fg (gap fill).
      if (i > strStart) pushTriple(strStart - lineFromAbs, i - lineFromAbs, S.STRING);
      pushTriple(i - lineFromAbs, i + 2 - lineFromAbs, S.STRING);
      i += 2;
      let depth = 1;
      while (i < lineTo && depth > 0) {
        const c = text.charCodeAt(i);
        if (c === 123) depth++;
        else if (c === 125) depth--;
        if (depth > 0) i++;
      }
      if (depth === 0) {
        pushTriple(i - lineFromAbs, i + 1 - lineFromAbs, S.STRING);
        i++;
      }
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
 * so they share `tokenizeCLike`. The structurally-distinct languages each get
 * one tokenizer + one dispatch arm. Every tokenizer targets the worker's final
 * S-classification (WORKER_RULES ∘ the grammar's styleTags) so the parse
 * arrival repaints with the same colors.
 */
export function syncTokenizeInto(source: CodeSource, language: CodeLanguage, out: CodeSpans): void {
  ensureSpansLineCap(out, source.lineCount);
  out.lineCount = source.lineCount;
  out.spanLineStart[0] = 0;

  switch (language) {
    case 'json':
      tokenizeJson(source, out);
      return;
    case 'sql':
      tokenizeSql(source, out);
      return;
    case 'css':
      tokenizeCss(source, out);
      return;
    case 'html':
      tokenizeHtml(source, out);
      return;
    default:
      tokenizeCLike(source, language, out);
  }
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

      // --- Property-access '.' → derefOperator (pink) ---
      if (cc === 46) {
        pushTriple(i - lineFrom, i + 1 - lineFrom, S.OPERATOR);
        i++;
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

// ============================================================================
// JSON TOKENIZER
// ============================================================================
//
// Lezer contract (@lezer/json → WORKER_RULES): PropertyName → TYPE (cyan),
// String → STRING, Number/true/false/null → NUMBER (purple), separators and
// brackets unstyled. A JSON string is ONE token (no Escape sub-token) and its
// closing quote is REQUIRED — an unterminated string is a Lezer error node
// (unstyled), so the sync floor emits nothing for it either.

const JSON_KW_BY_LEN: KwEntry[][] = buildKwTable([
  { word: 'true', style: S.NUMBER },
  { word: 'false', style: S.NUMBER },
  { word: 'null', style: S.NUMBER },
]);

/** Strict JSON number (`-? digits ('.' digits)? ([eE][+-]? digits)?`) — NOT
 * `scanNumber`: `0x1` must stay unstyled exactly like Lezer's error node. */
function scanJsonNumber(text: string, start: number, lineTo: number): number {
  let i = start;
  if (text.charCodeAt(i) === 45) i++;
  while (i < lineTo && isDigit(text.charCodeAt(i))) i++;
  if (i + 1 < lineTo && text.charCodeAt(i) === 46 && isDigit(text.charCodeAt(i + 1))) {
    i += 2;
    while (i < lineTo && isDigit(text.charCodeAt(i))) i++;
  }
  if (i < lineTo && (text.charCodeAt(i) | 32) === 101) {
    let j = i + 1;
    if (j < lineTo) {
      const s = text.charCodeAt(j);
      if (s === 43 || s === 45) j++;
    }
    if (j < lineTo && isDigit(text.charCodeAt(j))) {
      i = j + 1;
      while (i < lineTo && isDigit(text.charCodeAt(i))) i++;
    }
  }
  return i;
}

function tokenizeJson(source: CodeSource, out: CodeSpans): void {
  const lineCount = source.lineCount;
  const fullText = source.fullText;
  const lineStart = source.lineStart;
  let writeOffset = 0;

  // No cross-line state: JSON strings cannot span lines.
  for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
    const lineFrom = lineStart[lineIdx];
    const lineTo = lineStart[lineIdx + 1] - 1;
    const lineLen = lineTo - lineFrom;
    _syncBufCount = 0;
    let i = lineFrom;

    while (i < lineTo) {
      const cc = fullText.charCodeAt(i);

      if (cc === 34) {
        let closed = -1;
        for (let j = i + 1; j < lineTo; ) {
          const c = fullText.charCodeAt(j);
          if (c === 92) {
            j += 2;
          } else if (c === 34) {
            closed = j;
            break;
          } else {
            j++;
          }
        }
        if (closed === -1) {
          i = lineTo; // unterminated → Lezer error node → unstyled
          continue;
        }
        const end = closed + 1;
        // PropertyName heuristic: ws* then ':' after the closing quote.
        let k = end;
        while (k < lineTo && (fullText.charCodeAt(k) === 32 || fullText.charCodeAt(k) === 9)) k++;
        pushTriple(i - lineFrom, end - lineFrom, k < lineTo && fullText.charCodeAt(k) === 58 ? S.TYPE : S.STRING);
        i = end;
        continue;
      }

      if (isDigit(cc) || (cc === 45 && i + 1 < lineTo && isDigit(fullText.charCodeAt(i + 1)))) {
        const end = scanJsonNumber(fullText, i, lineTo);
        pushTriple(i - lineFrom, end - lineFrom, S.NUMBER);
        i = end;
        continue;
      }

      if (isIdentStart(cc)) {
        const start = i;
        i++;
        while (i < lineTo && isIdentPart(fullText.charCodeAt(i))) i++;
        const kw = classifyIdent(fullText, start, i, JSON_KW_BY_LEN);
        if (kw !== null) pushTriple(start - lineFrom, i - lineFrom, kw.style);
        continue;
      }

      i++; // punctuation / whitespace / garbage → gap
    }

    writeOffset = flushLine(out, lineLen, writeOffset, fullText, lineFrom, lineIdx);
  }
}

// ============================================================================
// SQL TOKENIZER — mirrors vendor/sql/tokens.ts decision-for-decision
// ============================================================================
//
// Lezer contract (vendored standard dialect → WORKER_RULES): Keyword → KEYWORD
// (pink, case-insensitive), Type → TYPE (cyan), true/false/null/unknown →
// NUMBER, strings/E-strings/"quoted idents" → STRING (one token, no escape
// splits; ' and " literals SPAN LINES), numbers/bits/hex → NUMBER, -- and
// nested /* */ → COMMENT, operator runs → OPERATOR. Identifiers, `?` vars and
// punctuation are unstyled. A word adjacent to `.` on either side is ALWAYS a
// plain Identifier (`order.date` stays white even though `order` is a keyword).

// Case-insensitive keyword tables: both sides of the compare are folded with
// `| 32` (letters → lowercase; digits/`_` map to themselves consistently), so
// classification costs one OR per char on top of the CI-less path.
function addKwCI(words: string, style: S, table: KwEntry[][]): void {
  for (const word of words.split(' ')) {
    const len = word.length;
    if (!table[len]) table[len] = [];
    const codes = new Uint8Array(len);
    for (let i = 0; i < len; i++) codes[i] = word.charCodeAt(i) | 32;
    table[len].push({ codes, style, definesNext: false });
  }
}

const SQL_KW_BY_LEN: KwEntry[][] = (() => {
  const table: KwEntry[][] = [];
  addKwCI(SQL_KEYWORDS, S.KEYWORD, table);
  addKwCI(SQL_TYPES, S.TYPE, table);
  addKwCI('true false null unknown', S.NUMBER, table); // Bool/Null terms
  return table;
})();

function classifyIdentCI(text: string, start: number, end: number, table: KwEntry[][]): KwEntry | null {
  const len = end - start;
  const bucket = table[len];
  if (!bucket) return null;
  outer: for (let i = 0; i < bucket.length; i++) {
    const entry = bucket[i];
    const codes = entry.codes;
    for (let j = 0; j < len; j++) {
      if ((text.charCodeAt(start + j) | 32) !== codes[j]) continue outer;
    }
    return entry;
  }
  return null;
}

// SQL char classes (mirrors the vendored tokenizer's table).
const SQLC_OP = 1; // * + - % < > ! = & | ~ ^ /
const SQLC_WORD = 2; // A-Z a-z 0-9 — upstream `isAlpha` (word start AND part; '_' is part-only)
const SQL_CLS = new Uint8Array(128);
for (const ch of '*+-%<>!=&|~^/') SQL_CLS[ch.charCodeAt(0)] |= SQLC_OP;
for (let c = 48; c <= 57; c++) SQL_CLS[c] |= SQLC_WORD;
for (let c = 65; c <= 90; c++) SQL_CLS[c] |= SQLC_WORD;
for (let c = 97; c <= 122; c++) SQL_CLS[c] |= SQLC_WORD;

function sqlCls(cc: number): number {
  return (cc & ~127) === 0 ? SQL_CLS[cc] : 0;
}

/** Scan to the closing quote from `bodyStart`. Returns the index AFTER the
 * close, or -1 if unterminated on this line (SQL literals span lines). */
function scanSqlLiteral(text: string, bodyStart: number, lineTo: number, quote: number, escapes: boolean): number {
  for (let j = bodyStart; j < lineTo; ) {
    const c = text.charCodeAt(j);
    if (escapes && c === 92) {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    j++;
  }
  return -1;
}

/** Mirror of upstream `readNumber`: digits with ONE dot, then `e[+-]?digits`
 * (the `e` and sign are consumed even with no digits after — upstream quirk). */
function scanSqlNumber(text: string, start: number, lineTo: number, sawDot: boolean): number {
  let i = start;
  while (i < lineTo) {
    const c = text.charCodeAt(i);
    if (c === 46) {
      if (sawDot) break;
      sawDot = true;
    } else if (c < 48 || c > 57) {
      break;
    }
    i++;
  }
  if (i < lineTo && (text.charCodeAt(i) | 32) === 101) {
    i++;
    if (i < lineTo) {
      const s = text.charCodeAt(i);
      if (s === 43 || s === 45) i++;
    }
    while (i < lineTo && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
  }
  return i;
}

function tokenizeSql(source: CodeSource, out: CodeSpans): void {
  const lineCount = source.lineCount;
  const fullText = source.fullText;
  const lineStart = source.lineStart;
  let writeOffset = 0;

  // Cross-line carries: ' " literals run to their closing quote wherever it
  // is; E'...' additionally honors backslash escapes; block comments NEST.
  let strQuote = 0; // 0 | 34 | 39
  let strEscapes = false;
  let commentDepth = 0;

  for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
    const lineFrom = lineStart[lineIdx];
    const lineTo = lineStart[lineIdx + 1] - 1;
    const lineLen = lineTo - lineFrom;
    _syncBufCount = 0;
    let i = lineFrom;

    while (i < lineTo) {
      // --- Nested block comment continuation ---
      if (commentDepth > 0) {
        const start = i;
        while (i < lineTo && commentDepth > 0) {
          const c = fullText.charCodeAt(i);
          if (c === 42 && i + 1 < lineTo && fullText.charCodeAt(i + 1) === 47) {
            commentDepth--;
            i += 2;
          } else if (c === 47 && i + 1 < lineTo && fullText.charCodeAt(i + 1) === 42) {
            commentDepth++;
            i += 2;
          } else {
            i++;
          }
        }
        if (commentDepth > 0) i = lineTo;
        pushTriple(start - lineFrom, i - lineFrom, S.COMMENT);
        continue;
      }

      // --- String / quoted-identifier continuation ---
      if (strQuote !== 0) {
        const end = scanSqlLiteral(fullText, i, lineTo, strQuote, strEscapes);
        if (end === -1) {
          pushTriple(i - lineFrom, lineTo - lineFrom, S.STRING);
          i = lineTo;
        } else {
          pushTriple(i - lineFrom, end - lineFrom, S.STRING);
          strQuote = 0;
          i = end;
        }
        continue;
      }

      const cc = fullText.charCodeAt(i);

      // --- Whitespace ---
      if (cc === 32 || cc === 9) {
        i++;
        continue;
      }

      // --- '...' string (no backslash escapes; '' reads as two strings) ---
      if (cc === 39) {
        const end = scanSqlLiteral(fullText, i + 1, lineTo, 39, false);
        if (end === -1) {
          pushTriple(i - lineFrom, lineTo - lineFrom, S.STRING);
          strQuote = 39;
          strEscapes = false;
          i = lineTo;
        } else {
          pushTriple(i - lineFrom, end - lineFrom, S.STRING);
          i = end;
        }
        continue;
      }

      // --- "--" line comment ---
      if (cc === 45 && i + 1 < lineTo && fullText.charCodeAt(i + 1) === 45) {
        pushTriple(i - lineFrom, lineTo - lineFrom, S.COMMENT);
        i = lineTo;
        continue;
      }

      // --- "/*" nested block comment open (opener emitted here, body by the
      //     continuation branch — two adjacent COMMENT triples, same paint) ---
      if (cc === 47 && i + 1 < lineTo && fullText.charCodeAt(i + 1) === 42) {
        pushTriple(i - lineFrom, i + 2 - lineFrom, S.COMMENT);
        commentDepth = 1;
        i += 2;
        continue;
      }

      // --- E'...' string with backslash escapes ---
      if ((cc | 32) === 101 && i + 1 < lineTo && fullText.charCodeAt(i + 1) === 39) {
        const end = scanSqlLiteral(fullText, i + 2, lineTo, 39, true);
        if (end === -1) {
          pushTriple(i - lineFrom, lineTo - lineFrom, S.STRING);
          strQuote = 39;
          strEscapes = true;
          i = lineTo;
        } else {
          pushTriple(i - lineFrom, end - lineFrom, S.STRING);
          i = end;
        }
        continue;
      }

      // --- "..." quoted identifier → special(string) → STRING ---
      if (cc === 34) {
        const end = scanSqlLiteral(fullText, i + 1, lineTo, 34, false);
        if (end === -1) {
          pushTriple(i - lineFrom, lineTo - lineFrom, S.STRING);
          strQuote = 34;
          strEscapes = false;
          i = lineTo;
        } else {
          pushTriple(i - lineFrom, end - lineFrom, S.STRING);
          i = end;
        }
        continue;
      }

      // --- b'0101' bits ---
      if ((cc | 32) === 98 && i + 1 < lineTo) {
        const q = fullText.charCodeAt(i + 1);
        if (q === 39 || q === 34) {
          let j = i + 2;
          while (j < lineTo) {
            const c = fullText.charCodeAt(j);
            if (c === 48 || c === 49) j++;
            else break;
          }
          if (j < lineTo && fullText.charCodeAt(j) === q) j++;
          pushTriple(i - lineFrom, j - lineFrom, S.NUMBER);
          i = j;
          continue;
        }
      }

      // --- 0x1F / x'FF' hex ---
      if (i + 1 < lineTo) {
        const nx = fullText.charCodeAt(i + 1);
        if ((cc === 48 && (nx | 32) === 120) || ((cc | 32) === 120 && nx === 39)) {
          const quoted = nx === 39;
          let j = i + 2;
          while (j < lineTo && isHexDigit(fullText.charCodeAt(j))) j++;
          if (quoted && j < lineTo && fullText.charCodeAt(j) === 39) j++;
          pushTriple(i - lineFrom, j - lineFrom, S.NUMBER);
          i = j;
          continue;
        }
      }

      // --- .5 / 5 / 1e3 numbers ---
      if (cc === 46 && i + 1 < lineTo && isDigit(fullText.charCodeAt(i + 1))) {
        const end = scanSqlNumber(fullText, i + 1, lineTo, true);
        pushTriple(i - lineFrom, end - lineFrom, S.NUMBER);
        i = end;
        continue;
      }
      if (cc >= 48 && cc <= 57) {
        const end = scanSqlNumber(fullText, i + 1, lineTo, false);
        pushTriple(i - lineFrom, end - lineFrom, S.NUMBER);
        i = end;
        continue;
      }

      // --- Operator run ---
      if ((sqlCls(cc) & SQLC_OP) !== 0) {
        const start = i;
        i++;
        while (i < lineTo && (sqlCls(fullText.charCodeAt(i)) & SQLC_OP) !== 0) i++;
        pushTriple(start - lineFrom, i - lineFrom, S.OPERATOR);
        continue;
      }

      // --- ? special var — consumed but unstyled (special(name) → DEFAULT) ---
      if (cc === 63) {
        i++;
        if (i < lineTo && fullText.charCodeAt(i) === 63) i++;
        if (i < lineTo) {
          const c = fullText.charCodeAt(i);
          if (c === 39 || c === 34 || c === 96) {
            const end = scanSqlLiteral(fullText, i + 1, lineTo, c, false);
            i = end === -1 ? lineTo : end;
          } else {
            while (i < lineTo) {
              const c2 = fullText.charCodeAt(i);
              if (c2 === 95 || (sqlCls(c2) & SQLC_WORD) !== 0) i++;
              else break;
            }
          }
        }
        continue;
      }

      // --- Word: keyword / type / bool / null — or plain Identifier ---
      if ((sqlCls(cc) & SQLC_WORD) !== 0) {
        const start = i;
        i++;
        while (i < lineTo) {
          const c = fullText.charCodeAt(i);
          if (c === 95 || (sqlCls(c) & SQLC_WORD) !== 0) i++;
          else break;
        }
        // Dot-adjacency: either side of '.' → always a plain Identifier.
        // Absolute indexing means a line-leading word peeks at '\n' — never 46.
        const prevCC = start > 0 ? fullText.charCodeAt(start - 1) : 0;
        const nextCC = i < lineTo ? fullText.charCodeAt(i) : 0;
        if (prevCC !== 46 && nextCC !== 46) {
          const kw = classifyIdentCI(fullText, start, i, SQL_KW_BY_LEN);
          if (kw !== null) pushTriple(start - lineFrom, i - lineFrom, kw.style);
        }
        continue;
      }

      i++; // punctuation, parens, ';' ':' ',' '.' '_' … → gap
    }

    writeOffset = flushLine(out, lineLen, writeOffset, fullText, lineFrom, lineIdx);
  }
}

// ============================================================================
// CSS TOKENIZER — context machine over a reusable SEGMENT scanner
// ============================================================================
//
// Lezer contract (@lezer/css → WORKER_RULES): element selectors → KEYWORD
// (pink, TagName); .class / :pseudo → FUNCTION_DEF green (className family);
// #id / @keyframes names → ATTRIBUTE green (labelName); [attr names →
// ATTRIBUTE; property names → TYPE (cyan); value keywords → NUMBER (purple —
// t.atom, pinned by JS `super`); functions (`rgb(`, `var(`) → KEYWORD (Callee
// → operatorKeyword); `--custom-props` → unstyled (VariableName, fg); numbers
// + #hex colors → NUMBER with the trailing Unit/`%` split out as KEYWORD
// (pink); strings + raw url() content → STRING; @-keywords → STORAGE (cyan);
// !important → MODIFIER; combinators/match-ops/calc-ops → OPERATOR;
// `: ; , ( ) { }` → unstyled.
//
// The core is `scanCssSegment(text, from, to, lineFrom)` over a module scratch
// (`_cssScan`, stable shape, reused — zero alloc): `tokenizeCss` drives it one
// line at a time, and `tokenizeHtml` drives the SAME core over `<style>` body
// segments, so embedded CSS highlights identically to a css block.
//
// Known heuristic gaps (worker corrects in ~1 frame): CSS-nesting selector vs
// property disambiguation is a bounded lookahead for '{' before ';'/'}' on the
// same line; @-prelude value keywords render pink where Lezer may differ.

const CSSC_IDENT = 1; // a-z A-Z 0-9 _ -
const CSSC_START = 2; // a-z A-Z _
const CSS_CLS = new Uint8Array(128);
for (let c = 48; c <= 57; c++) CSS_CLS[c] |= CSSC_IDENT;
for (let c = 65; c <= 90; c++) CSS_CLS[c] |= CSSC_IDENT | CSSC_START;
for (let c = 97; c <= 122; c++) CSS_CLS[c] |= CSSC_IDENT | CSSC_START;
CSS_CLS[95] |= CSSC_IDENT | CSSC_START;
CSS_CLS[45] |= CSSC_IDENT;

function cssCls(cc: number): number {
  return (cc & ~127) === 0 ? CSS_CLS[cc] : 0;
}

/** Case-insensitive span compare against a lowercase word. */
function spanEqualsCI(text: string, from: number, to: number, word: string): boolean {
  if (to - from !== word.length) return false;
  for (let k = 0; k < word.length; k++) {
    if ((text.charCodeAt(from + k) | 32) !== word.charCodeAt(k)) return false;
  }
  return true;
}

/** Case-insensitive suffix compare against a lowercase word. */
function endsWithCI(text: string, from: number, to: number, word: string): boolean {
  const n = word.length;
  if (to - from < n) return false;
  for (let k = 0; k < n; k++) {
    if ((text.charCodeAt(to - n + k) | 32) !== word.charCodeAt(k)) return false;
  }
  return true;
}

// CSS scan state — module scratch (stable shape, reused across lines and
// across the two consumers; scans never interleave on the single main thread).
// mode: 0 SELECTOR | 1 BLOCK (declarations) | 2 VALUE (after ':') | 3 @-PRELUDE
const _cssScan = { mode: 0, depth: 0, inComment: false, keyframes: false, inAttr: false, prevSig: 0 };

function resetCssScan(): void {
  _cssScan.mode = 0;
  _cssScan.depth = 0;
  _cssScan.inComment = false;
  _cssScan.keyframes = false;
  _cssScan.inAttr = false;
  _cssScan.prevSig = 0;
}

/** Scan one same-line CSS segment `[from, to)`; triples line-relative to `lineFrom`. */
function scanCssSegment(text: string, from: number, to: number, lineFrom: number): void {
  const st = _cssScan;
  let i = from;

  while (i < to) {
    // --- Block comment continuation ---
    if (st.inComment) {
      const end = text.indexOf('*/', i);
      if (end === -1 || end >= to) {
        pushTriple(i - lineFrom, to - lineFrom, S.COMMENT);
        i = to;
      } else {
        pushTriple(i - lineFrom, end + 2 - lineFrom, S.COMMENT);
        i = end + 2;
        st.inComment = false;
      }
      continue;
    }

    const cc = text.charCodeAt(i);

    // --- Whitespace (prevSig deliberately untouched: `div .cls` resolves) ---
    if (cc === 32 || cc === 9) {
      i++;
      continue;
    }

    // --- Comment open (opener emitted here, body by the continuation) ---
    if (cc === 47 && i + 1 < to && text.charCodeAt(i + 1) === 42) {
      pushTriple(i - lineFrom, i + 2 - lineFrom, S.COMMENT);
      st.inComment = true;
      i += 2;
      continue;
    }

    // --- Strings ---
    if (cc === 34 || cc === 39) {
      let j = i + 1;
      while (j < to) {
        const c = text.charCodeAt(j);
        if (c === 92) {
          j += 2;
          continue;
        }
        j++;
        if (c === cc) break;
      }
      if (j > to) j = to;
      pushTriple(i - lineFrom, j - lineFrom, S.STRING);
      i = j;
      st.prevSig = 0;
      continue;
    }

    // --- Structure: { } ; : ---
    if (cc === 123) {
      st.depth++;
      st.mode = st.mode === 3 ? 0 : 1; // @-prelude { → nested rules; selector { → declarations
      st.keyframes = false;
      st.prevSig = 123;
      i++;
      continue;
    }
    if (cc === 125) {
      if (st.depth > 0) st.depth--;
      st.mode = st.depth === 0 ? 0 : 1; // BLOCK-mode ident lookahead self-corrects nested rules
      st.keyframes = false;
      st.prevSig = 125;
      i++;
      continue;
    }
    if (cc === 59) {
      if (st.mode === 2)
        st.mode = 1; // end of declaration
      else if (st.mode === 3) st.mode = 0; // @import …;
      st.prevSig = 59;
      i++;
      continue;
    }
    if (cc === 58) {
      // ':' and '::' are both unstyled (punctuation) — verified against the
      // grammar; prevSig 58 marks pseudo context for the following ident.
      if (st.mode === 1) st.mode = 2; // property → value
      st.prevSig = 58;
      i++;
      continue;
    }

    // --- @-keyword ---
    if (cc === 64 && i + 1 < to && (cssCls(text.charCodeAt(i + 1)) & CSSC_START) !== 0) {
      const start = i;
      i++;
      while (i < to && (cssCls(text.charCodeAt(i)) & CSSC_IDENT) !== 0) i++;
      pushTriple(start - lineFrom, i - lineFrom, S.STORAGE);
      st.mode = 3;
      st.keyframes = endsWithCI(text, start + 1, i, 'keyframes');
      st.prevSig = 0;
      continue;
    }

    // --- # : IdName (selector) vs ColorLiteral (value/prelude) ---
    if (cc === 35) {
      if (st.mode >= 2) {
        let j = i + 1;
        while (j < to && isHexDigit(text.charCodeAt(j))) j++;
        pushTriple(i - lineFrom, j - lineFrom, S.NUMBER);
        i = j;
        st.prevSig = 0;
      } else {
        pushTriple(i - lineFrom, i + 1 - lineFrom, S.OPERATOR); // '#' → derefOperator
        st.prevSig = 35;
        i++;
      }
      continue;
    }

    // --- Numbers (+ trailing Unit/% split) ---
    if (
      isDigit(cc) ||
      (cc === 46 && i + 1 < to && isDigit(text.charCodeAt(i + 1))) ||
      ((cc === 45 || cc === 43) &&
        st.mode >= 2 &&
        i + 1 < to &&
        (isDigit(text.charCodeAt(i + 1)) || (text.charCodeAt(i + 1) === 46 && i + 2 < to && isDigit(text.charCodeAt(i + 2)))))
    ) {
      const start = i;
      if (cc === 45 || cc === 43) i++;
      if (text.charCodeAt(i) === 46) i++;
      while (i < to && isDigit(text.charCodeAt(i))) i++;
      if (i + 1 < to && text.charCodeAt(i) === 46 && isDigit(text.charCodeAt(i + 1))) {
        i++;
        while (i < to && isDigit(text.charCodeAt(i))) i++;
      }
      // Exponent only when digits follow ('2em' must fall to the unit scan).
      if (i < to && (text.charCodeAt(i) | 32) === 101) {
        let j = i + 1;
        if (j < to && (text.charCodeAt(j) === 43 || text.charCodeAt(j) === 45)) j++;
        if (j < to && isDigit(text.charCodeAt(j))) {
          i = j + 1;
          while (i < to && isDigit(text.charCodeAt(i))) i++;
        }
      }
      pushTriple(start - lineFrom, i - lineFrom, S.NUMBER);
      if (i < to) {
        const u = text.charCodeAt(i);
        if (u === 37) {
          pushTriple(i - lineFrom, i + 1 - lineFrom, S.KEYWORD); // '%' unit
          i++;
        } else if ((cssCls(u) & CSSC_START) !== 0) {
          const us = i;
          while (i < to && (cssCls(text.charCodeAt(i)) & CSSC_START) !== 0) i++;
          pushTriple(us - lineFrom, i - lineFrom, S.KEYWORD); // unit letters
        }
      }
      st.prevSig = 0;
      continue;
    }

    // --- !important ---
    if (cc === 33) {
      let j = i + 1;
      while (j < to && (cssCls(text.charCodeAt(j)) & CSSC_IDENT) !== 0) j++;
      if (spanEqualsCI(text, i + 1, j, 'important')) {
        pushTriple(i - lineFrom, j - lineFrom, S.MODIFIER);
        i = j;
        st.prevSig = 0;
        continue;
      }
      st.prevSig = 33;
      i++;
      continue;
    }

    // --- [attr] selector context ---
    if (cc === 91 && st.mode <= 1) {
      st.inAttr = true;
      st.prevSig = 91;
      i++;
      continue;
    }
    if (cc === 93) {
      st.inAttr = false;
      st.prevSig = 93;
      i++;
      continue;
    }

    // --- Identifiers ---
    if (
      (cssCls(cc) & CSSC_START) !== 0 ||
      (cc === 45 && i + 1 < to && ((cssCls(text.charCodeAt(i + 1)) & CSSC_START) !== 0 || text.charCodeAt(i + 1) === 45))
    ) {
      const start = i;
      i++;
      while (i < to && (cssCls(text.charCodeAt(i)) & CSSC_IDENT) !== 0) i++;
      const isCustomProp = cc === 45 && text.charCodeAt(start + 1) === 45;
      let m = st.mode;

      if (m === 1 && !isCustomProp) {
        // Nested-selector vs property: '{' before ';'/'}' on this line ⇒ selector.
        for (let j = i; j < to; j++) {
          const c = text.charCodeAt(j);
          if (c === 123) {
            st.mode = 0;
            m = 0;
            break;
          }
          if (c === 59 || c === 125) break;
        }
      }

      if (m === 0) {
        const p = st.prevSig;
        if (st.inAttr) {
          pushTriple(start - lineFrom, i - lineFrom, p === 91 ? S.ATTRIBUTE : S.NUMBER); // name vs unquoted value
        } else if (p === 46 || p === 58) {
          pushTriple(start - lineFrom, i - lineFrom, S.FUNCTION_DEF); // .class / :pseudo → className green
        } else if (p === 35) {
          pushTriple(start - lineFrom, i - lineFrom, S.ATTRIBUTE); // #id → labelName green
        } else {
          pushTriple(start - lineFrom, i - lineFrom, S.KEYWORD); // TagName
        }
      } else if (m === 1) {
        if (!isCustomProp) pushTriple(start - lineFrom, i - lineFrom, S.TYPE); // PropertyName
      } else if (!isCustomProp) {
        const nextCC = i < to ? text.charCodeAt(i) : 0;
        if (nextCC === 40) {
          // CallTag literals (url/url-prefix/domain/regexp) → atom (purple);
          // every other function name → Callee → operatorKeyword (pink).
          const callTag =
            spanEqualsCI(text, start, i, 'url') ||
            spanEqualsCI(text, start, i, 'url-prefix') ||
            spanEqualsCI(text, start, i, 'domain') ||
            spanEqualsCI(text, start, i, 'regexp');
          pushTriple(start - lineFrom, i - lineFrom, callTag ? S.NUMBER : S.KEYWORD);
          if (callTag) {
            // Raw call-literal content → ParenthesizedContent → yellow
            let j = i + 1;
            while (j < to && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
            const c = j < to ? text.charCodeAt(j) : 0;
            if (c !== 0 && c !== 34 && c !== 39 && c !== 41) {
              let k = j;
              while (k < to && text.charCodeAt(k) !== 41) k++;
              pushTriple(i + 1 - lineFrom, k - lineFrom, S.STRING);
              i = k;
            }
          }
        } else if (m === 3) {
          if (st.keyframes) {
            pushTriple(start - lineFrom, i - lineFrom, S.ATTRIBUTE); // KeyframeName → labelName green
          } else {
            let k = i;
            while (k < to && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
            const featureName = k < to && text.charCodeAt(k) === 58;
            pushTriple(start - lineFrom, i - lineFrom, featureName ? S.TYPE : S.KEYWORD);
          }
        } else {
          pushTriple(start - lineFrom, i - lineFrom, S.NUMBER); // ValueName → atom purple
        }
      }
      st.prevSig = 0;
      continue;
    }

    // --- Operators ---
    if (st.mode <= 1) {
      // Combinators, universal/nesting selectors, [attr] match-ops: * & > ~ + = ^ $
      if (cc === 42 || cc === 38 || cc === 62 || cc === 126 || cc === 43 || cc === 61 || cc === 94 || cc === 36) {
        const start = i;
        i++;
        while (i < to) {
          const c = text.charCodeAt(i);
          if (c === 42 || c === 38 || c === 62 || c === 126 || c === 43 || c === 61 || c === 94 || c === 36) i++;
          else break;
        }
        pushTriple(start - lineFrom, i - lineFrom, S.OPERATOR);
        st.prevSig = text.charCodeAt(i - 1);
        continue;
      }
    } else if (cc === 43 || cc === 45 || cc === 42 || cc === 47) {
      pushTriple(i - lineFrom, i + 1 - lineFrom, S.OPERATOR); // calc / shorthand ops
      st.prevSig = cc;
      i++;
      continue;
    }

    st.prevSig = cc;
    i++;
  }
}

function tokenizeCss(source: CodeSource, out: CodeSpans): void {
  const lineCount = source.lineCount;
  const fullText = source.fullText;
  const lineStart = source.lineStart;
  let writeOffset = 0;

  resetCssScan();
  for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
    const lineFrom = lineStart[lineIdx];
    const lineTo = lineStart[lineIdx + 1] - 1;
    _syncBufCount = 0;
    scanCssSegment(fullText, lineFrom, lineTo, lineFrom);
    writeOffset = flushLine(out, lineTo - lineFrom, writeOffset, fullText, lineFrom, lineIdx);
  }
}

// ============================================================================
// HTML TOKENIZER — markup modes + REAL embedded <script>/<style> highlighting
// ============================================================================
//
// Lezer contract (@lezer/html + lang-html default nesting → WORKER_RULES):
// angle brackets + tag names → KEYWORD (pink); attribute names → ATTRIBUTE
// (green); '=' → OPERATOR; attribute values (quoted + unquoted) → STRING
// (attributeValue row); text → unstyled; &entity; refs → STRING (t.character);
// <!-- --> → COMMENT; <!DOCTYPE>/<?…> → LANG_VAR (documentMeta/PI → meta,
// purple). <script>/<style> bodies run real embedded scans so typing inside
// them doesn't shimmer: JS via `scanJsSegment` (simplified tokenizeCLike over
// the shared atoms + JS keyword table), CSS via the SAME `scanCssSegment` the
// css blocks use. NOT emulated by the floor (worker corrects in ~1 frame):
// `type=`-attr dialect switches (floor always scans plain JS) and style/on*
// ATTRIBUTE nesting (floor paints them as plain yellow attr values).

// Embedded-JS scan state — module scratch, reset at every <script> entry.
const _jsScan = { inBlockComment: false, inTemplate: false, defIsFunc: false, prevSig: 0 };

function resetJsScan(): void {
  _jsScan.inBlockComment = false;
  _jsScan.inTemplate = false;
  _jsScan.defIsFunc = false;
  _jsScan.prevSig = 0;
}

/** Simplified C-like scan for embedded <script> segments `[from, to)` —
 * strings/templates/comments/numbers/keywords/idents with the FUNCTION_DEF and
 * property-access TYPE carries. Reuses the module scan atoms directly. */
function scanJsSegment(text: string, from: number, to: number, lineFrom: number): void {
  const st = _jsScan;
  let i = from;

  while (i < to) {
    if (st.inBlockComment) {
      const end = text.indexOf('*/', i);
      if (end === -1 || end >= to) {
        pushTriple(i - lineFrom, to - lineFrom, S.COMMENT);
        i = to;
      } else {
        pushTriple(i - lineFrom, end + 2 - lineFrom, S.COMMENT);
        i = end + 2;
        st.inBlockComment = false;
      }
      continue;
    }
    if (st.inTemplate) {
      const end = scanTemplateLiteral(text, i, to, lineFrom);
      if (end === -1) {
        i = to;
      } else {
        i = end;
        st.inTemplate = false;
        st.prevSig = 96;
        st.defIsFunc = false;
      }
      continue;
    }

    const cc = text.charCodeAt(i);
    if (cc === 32 || cc === 9) {
      i++;
      continue;
    }

    if (cc === 47 && i + 1 < to) {
      const next = text.charCodeAt(i + 1);
      if (next === 47) {
        pushTriple(i - lineFrom, to - lineFrom, S.COMMENT);
        i = to;
        continue;
      }
      if (next === 42) {
        pushTriple(i - lineFrom, i + 2 - lineFrom, S.COMMENT);
        st.inBlockComment = true;
        i += 2;
        continue;
      }
    }

    if (cc === 34 || cc === 39) {
      i = scanQuotedString(text, i, i, to, cc, lineFrom);
      st.prevSig = cc;
      st.defIsFunc = false;
      continue;
    }
    if (cc === 96) {
      pushTriple(i - lineFrom, i + 1 - lineFrom, S.STRING);
      const end = scanTemplateLiteral(text, i + 1, to, lineFrom);
      if (end === -1) {
        i = to;
        st.inTemplate = true;
      } else {
        i = end;
        st.prevSig = 96;
      }
      st.defIsFunc = false;
      continue;
    }

    if (isDigit(cc) || (cc === 46 && i + 1 < to && isDigit(text.charCodeAt(i + 1)))) {
      const start = i;
      i = scanNumber(text, i, to);
      pushTriple(start - lineFrom, i - lineFrom, S.NUMBER);
      st.prevSig = 0;
      st.defIsFunc = false;
      continue;
    }

    if (isIdentStart(cc)) {
      const start = i;
      i++;
      while (i < to && isIdentPart(text.charCodeAt(i))) i++;
      const kw = classifyIdent(text, start, i, JS_KW_BY_LEN);
      if (kw !== null) {
        pushTriple(start - lineFrom, i - lineFrom, kw.style);
        st.defIsFunc = kw.definesNext;
      } else if (st.defIsFunc) {
        pushTriple(start - lineFrom, i - lineFrom, S.FUNCTION_DEF);
        st.defIsFunc = false;
      } else if (i < to && text.charCodeAt(i) === 40) {
        pushTriple(start - lineFrom, i - lineFrom, S.FUNCTION_CALL);
      } else {
        const firstCC = text.charCodeAt(start);
        if (firstCC >= 65 && firstCC <= 90) pushTriple(start - lineFrom, i - lineFrom, S.TYPE);
        else if (st.prevSig === 46) pushTriple(start - lineFrom, i - lineFrom, S.TYPE);
        // plain identifiers are fg — the gap fill covers them
      }
      st.prevSig = text.charCodeAt(i - 1);
      continue;
    }

    if (isOperator(cc)) {
      const start = i;
      i++;
      while (i < to && isOperator(text.charCodeAt(i))) i++;
      pushTriple(start - lineFrom, i - lineFrom, S.OPERATOR);
      st.prevSig = text.charCodeAt(i - 1);
      st.defIsFunc = false;
      continue;
    }

    if (cc === 46) {
      pushTriple(i - lineFrom, i + 1 - lineFrom, S.OPERATOR); // '.' derefOperator (also covers '...' as 3 pink dots)
      st.prevSig = 46;
      st.defIsFunc = false;
      i++;
      continue;
    }

    st.prevSig = cc;
    st.defIsFunc = false;
    i++;
  }
}

function isHtmlNameStart(cc: number): boolean {
  return (cc >= 97 && cc <= 122) || (cc >= 65 && cc <= 90);
}

function isHtmlNamePart(cc: number): boolean {
  return (cc >= 97 && cc <= 122) || (cc >= 65 && cc <= 90) || (cc >= 48 && cc <= 57) || cc === 45 || cc === 95 || cc === 58 || cc === 46;
}

/** Find a case-insensitive `</name` (name lowercase) whose next char closes
 * the tag name (`> \t /` or line end). Returns the index of '<', or -1. */
function findCloseTagCI(text: string, from: number, to: number, name: string): number {
  const n = name.length;
  for (let i = from; i + 2 + n <= to; i++) {
    if (text.charCodeAt(i) !== 60 || text.charCodeAt(i + 1) !== 47) continue;
    let k = 0;
    for (; k < n; k++) {
      if ((text.charCodeAt(i + 2 + k) | 32) !== name.charCodeAt(k)) break;
    }
    if (k < n) continue;
    const after = i + 2 + n < to ? text.charCodeAt(i + 2 + n) : 10;
    if (after === 62 || after === 32 || after === 9 || after === 47 || after === 10) return i;
  }
  return -1;
}

// HTML scan modes (cross-line).
const H_TEXT = 0;
const H_TAG = 1;
const H_ATTRVAL = 2;
const H_COMMENT = 3;
const H_META = 4; // <!DOCTYPE …> / <?…> — runs to '>'
const H_RAWJS = 5;
const H_RAWCSS = 6;

function tokenizeHtml(source: CodeSource, out: CodeSpans): void {
  const lineCount = source.lineCount;
  const fullText = source.fullText;
  const lineStart = source.lineStart;
  let writeOffset = 0;

  let mode = H_TEXT;
  let attrQuote = 0; // quote char of a value spanning lines
  let isCloseTag = false; // current TAG entered via '</'
  let sawTagName = false; // first ident in TAG is the tag name
  let pendingRaw = 0; // armed by <script>/<style> names: 0 none | 1 js | 2 css
  let prevEq = false; // last significant TAG char was '=' (unquoted value next)
  resetJsScan();
  resetCssScan();

  for (let lineIdx = 0; lineIdx < lineCount; lineIdx++) {
    const lineFrom = lineStart[lineIdx];
    const lineTo = lineStart[lineIdx + 1] - 1;
    const lineLen = lineTo - lineFrom;
    _syncBufCount = 0;
    let i = lineFrom;

    while (i < lineTo) {
      if (mode === H_COMMENT) {
        const end = fullText.indexOf('-->', i);
        if (end === -1 || end + 3 > lineTo) {
          pushTriple(i - lineFrom, lineTo - lineFrom, S.COMMENT);
          i = lineTo;
        } else {
          pushTriple(i - lineFrom, end + 3 - lineFrom, S.COMMENT);
          i = end + 3;
          mode = H_TEXT;
        }
        continue;
      }

      if (mode === H_META) {
        let j = i;
        while (j < lineTo && fullText.charCodeAt(j) !== 62) j++;
        if (j < lineTo) {
          pushTriple(i - lineFrom, j + 1 - lineFrom, S.LANG_VAR);
          i = j + 1;
          mode = H_TEXT;
        } else {
          pushTriple(i - lineFrom, lineTo - lineFrom, S.LANG_VAR);
          i = lineTo;
        }
        continue;
      }

      if (mode === H_ATTRVAL) {
        let j = i;
        while (j < lineTo && fullText.charCodeAt(j) !== attrQuote) j++;
        if (j < lineTo) {
          pushTriple(i - lineFrom, j + 1 - lineFrom, S.STRING);
          i = j + 1;
          mode = H_TAG;
        } else {
          pushTriple(i - lineFrom, lineTo - lineFrom, S.STRING);
          i = lineTo;
        }
        continue;
      }

      if (mode === H_RAWJS || mode === H_RAWCSS) {
        const close = findCloseTagCI(fullText, i, lineTo, mode === H_RAWJS ? 'script' : 'style');
        const segEnd = close === -1 ? lineTo : close;
        if (segEnd > i) {
          if (mode === H_RAWJS) scanJsSegment(fullText, i, segEnd, lineFrom);
          else scanCssSegment(fullText, i, segEnd, lineFrom);
        }
        if (close === -1) {
          i = lineTo;
        } else {
          pushTriple(close - lineFrom, close + 2 - lineFrom, S.KEYWORD); // '</'
          i = close + 2;
          mode = H_TAG;
          isCloseTag = true;
          sawTagName = false;
          prevEq = false;
        }
        continue;
      }

      if (mode === H_TAG) {
        const cc = fullText.charCodeAt(i);
        if (cc === 32 || cc === 9) {
          i++;
          continue;
        }
        if (cc === 62) {
          pushTriple(i - lineFrom, i + 1 - lineFrom, S.KEYWORD); // '>'
          i++;
          // Per the HTML spec a stray '/' before '>' does NOT self-close
          // script/style — rawtext still runs to the explicit close tag.
          if (pendingRaw === 1) {
            mode = H_RAWJS;
            resetJsScan();
          } else if (pendingRaw === 2) {
            mode = H_RAWCSS;
            resetCssScan();
          } else {
            mode = H_TEXT;
          }
          pendingRaw = 0;
          prevEq = false;
          continue;
        }
        if (cc === 47) {
          pushTriple(i - lineFrom, i + 1 - lineFrom, S.KEYWORD); // '/' of '/>'
          i++;
          continue;
        }
        if (cc === 61) {
          pushTriple(i - lineFrom, i + 1 - lineFrom, S.OPERATOR); // '=' (Is)
          prevEq = true;
          i++;
          continue;
        }
        if (cc === 34 || cc === 39) {
          let j = i + 1;
          while (j < lineTo && fullText.charCodeAt(j) !== cc) j++;
          if (j < lineTo) {
            pushTriple(i - lineFrom, j + 1 - lineFrom, S.STRING);
            i = j + 1;
          } else {
            pushTriple(i - lineFrom, lineTo - lineFrom, S.STRING);
            i = lineTo;
            mode = H_ATTRVAL;
            attrQuote = cc;
          }
          prevEq = false;
          continue;
        }
        if (isHtmlNameStart(cc)) {
          const start = i;
          i++;
          while (i < lineTo && isHtmlNamePart(fullText.charCodeAt(i))) i++;
          if (!sawTagName) {
            pushTriple(start - lineFrom, i - lineFrom, S.KEYWORD); // TagName
            sawTagName = true;
            if (!isCloseTag) {
              if (spanEqualsCI(fullText, start, i, 'script')) pendingRaw = 1;
              else if (spanEqualsCI(fullText, start, i, 'style')) pendingRaw = 2;
            }
          } else if (prevEq) {
            pushTriple(start - lineFrom, i - lineFrom, S.STRING); // unquoted attr value
          } else {
            pushTriple(start - lineFrom, i - lineFrom, S.ATTRIBUTE); // attr name
          }
          prevEq = false;
          continue;
        }
        i++; // stray char inside tag
        continue;
      }

      // --- H_TEXT ---
      const cc = fullText.charCodeAt(i);
      if (cc === 60) {
        const n1 = i + 1 < lineTo ? fullText.charCodeAt(i + 1) : 0;
        if (n1 === 33) {
          mode = i + 3 < lineTo && fullText.charCodeAt(i + 2) === 45 && fullText.charCodeAt(i + 3) === 45 ? H_COMMENT : H_META;
          continue; // the mode branch emits from '<'
        }
        if (n1 === 63) {
          mode = H_META; // <?processing instruction?>
          continue;
        }
        if (n1 === 47) {
          pushTriple(i - lineFrom, i + 2 - lineFrom, S.KEYWORD); // '</'
          i += 2;
          mode = H_TAG;
          isCloseTag = true;
          sawTagName = false;
          prevEq = false;
          continue;
        }
        if (isHtmlNameStart(n1)) {
          pushTriple(i - lineFrom, i + 1 - lineFrom, S.KEYWORD); // '<'
          i++;
          mode = H_TAG;
          isCloseTag = false;
          sawTagName = false;
          pendingRaw = 0;
          prevEq = false;
          continue;
        }
        i++; // lone '<' → text (IncompleteTag → content, unstyled)
        continue;
      }
      if (cc === 38) {
        // &entity; / &#160; → t.character → STRING
        let j = i + 1;
        if (j < lineTo && fullText.charCodeAt(j) === 35) j++;
        const bodyStart = j;
        while (j < lineTo) {
          const c = fullText.charCodeAt(j);
          if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)) j++;
          else break;
        }
        if (j > bodyStart && j < lineTo && fullText.charCodeAt(j) === 59) {
          pushTriple(i - lineFrom, j + 1 - lineFrom, S.STRING);
          i = j + 1;
        } else {
          i++;
        }
        continue;
      }
      i++; // text → gap
    }

    writeOffset = flushLine(out, lineLen, writeOffset, fullText, lineFrom, lineIdx);
  }
}
