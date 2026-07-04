/**
 * Vendored from @codemirror/lang-sql@6.10.0 (src/tokens.ts), MIT © Marijn
 * Haverbeke and others.
 *
 * Specialized: upstream's dialect-parameterized `tokensFor(dialect)` is
 * constant-folded to the **standard SQL dialect** (the only one we ship —
 * the UI shows "SQL"). Every dialect branch is resolved at write time:
 *
 *   backslashEscapes=false · hashComments=false · slashComments=false ·
 *   spaceAfterDashes=false · doubleQuotedStrings=false ·
 *   doubleDollarQuotedStrings=false · unquotedBitLiterals=false ·
 *   treatBitsAsBytes=false · charSetCasts=false · plsqlQuotingMechanism=false ·
 *   operatorChars="*+-%<>!=&|~^/" · specialVar="?" · identifierQuotes='"'
 *
 * Branch order matches upstream exactly — the sync-floor tokenizer
 * (`tokenizeSql` in code-tokenizer.ts) mirrors this file decision-for-decision
 * so there is no color flip when the worker parse arrives.
 *
 * Worker-safe: imports @lezer/lr + the generated terms only.
 */

import { ExternalTokenizer, type InputStream } from '@lezer/lr';

import { SQL_KEYWORDS, SQL_TYPES } from './keywords';
import {
  Bits,
  BlockComment,
  Bool,
  BraceL,
  BraceR,
  BracketL,
  BracketR,
  Dot,
  Identifier,
  Keyword,
  LineComment,
  Null,
  Number as NumberToken,
  Operator,
  ParenL,
  ParenR,
  Punctuation,
  QuotedIdentifier,
  Semi,
  SpecialVar,
  String as StringToken,
  Type,
  whitespace,
} from './sql.grammar.terms';

// ============================================================================
// CHAR CLASSES — one 128-entry table, one load + mask per membership test
// (replaces upstream's per-char `inString(ch, str)` scans).
// ============================================================================

const C_SPACE = 1; //  \t\r\n
const C_ALPHA = 2; // A-Z a-z 0-9  (upstream isAlpha includes digits)
const C_HEX = 4; //   0-9 a-f A-F
const C_OP = 8; //    * + - % < > ! = & | ~ ^ /
const C_DIGIT = 16; // 0-9

const CLS = new Uint8Array(128);
for (const cc of [32, 9, 13, 10]) CLS[cc] |= C_SPACE;
for (let cc = 48; cc <= 57; cc++) CLS[cc] |= C_ALPHA | C_HEX | C_DIGIT;
for (let cc = 97; cc <= 122; cc++) CLS[cc] |= C_ALPHA;
for (let cc = 65; cc <= 90; cc++) CLS[cc] |= C_ALPHA;
for (let cc = 97; cc <= 102; cc++) CLS[cc] |= C_HEX;
for (let cc = 65; cc <= 70; cc++) CLS[cc] |= C_HEX;
for (const ch of '*+-%<>!=&|~^/') CLS[ch.charCodeAt(0)] |= C_OP;

/** Class bits for `ch`, 0 for EOF (-1) and non-ASCII. */
function cls(ch: number): number {
  return (ch & ~127) === 0 ? CLS[ch] : 0;
}

// ============================================================================
// SCAN ATOMS — ported verbatim (minus dialect params)
// ============================================================================

function readLiteral(input: InputStream, endQuote: number, backslashEscapes: boolean): void {
  for (let escaped = false; ; ) {
    if (input.next < 0) return;
    if (input.next === endQuote && !escaped) {
      input.advance();
      return;
    }
    escaped = backslashEscapes && !escaped && input.next === 92; /* \ */
    input.advance();
  }
}

function readWord(input: InputStream, result: string): string {
  for (;;) {
    if (input.next !== 95 /* _ */ && (cls(input.next) & C_ALPHA) === 0) break;
    result += String.fromCharCode(input.next);
    input.advance();
  }
  return result;
}

function readWordOrQuoted(input: InputStream): void {
  if (input.next === 39 || input.next === 34 || input.next === 96) {
    const quote = input.next;
    input.advance();
    readLiteral(input, quote, false);
  } else {
    readWord(input, '');
  }
}

function readBits(input: InputStream, endQuote: number): void {
  while (input.next === 48 || input.next === 49) input.advance();
  if (endQuote && input.next === endQuote) input.advance();
}

function readNumber(input: InputStream, sawDot: boolean): void {
  for (;;) {
    if (input.next === 46 /* . */) {
      if (sawDot) break;
      sawDot = true;
    } else if ((cls(input.next) & C_DIGIT) === 0) {
      break;
    }
    input.advance();
  }
  if (input.next === 69 || input.next === 101 /* e E */) {
    input.advance();
    const sign: number = input.next; // fresh read — TS still narrows input.next to e|E here
    if (sign === 43 || sign === 45 /* + - */) input.advance();
    while ((cls(input.next) & C_DIGIT) !== 0) input.advance();
  }
}

function eol(input: InputStream): void {
  while (!(input.next < 0 || input.next === 10)) input.advance();
}

// ============================================================================
// KEYWORDS — standard SQL word list (`./keywords`, shared with the sync floor)
// ============================================================================

/** word (lowercase) → term id. Standard dialect: no builtins. */
const WORDS: Record<string, number> = Object.create(null);
WORDS.true = WORDS.false = Bool;
WORDS.null = WORDS.unknown = Null;
for (const kw of SQL_KEYWORDS.split(' ')) WORDS[kw] = Keyword;
for (const tp of SQL_TYPES.split(' ')) WORDS[tp] = Type;

// ============================================================================
// THE TOKENIZER — upstream `tokensFor(defaults)`, branches folded
// ============================================================================

export const tokens = new ExternalTokenizer((input) => {
  const next = input.next;
  input.advance();
  if ((cls(next) & C_SPACE) !== 0) {
    while ((cls(input.next) & C_SPACE) !== 0) input.advance();
    input.acceptToken(whitespace);
  } else if (next === 39 /* ' */) {
    readLiteral(input, 39, false);
    input.acceptToken(StringToken);
  } else if (next === 45 /* - */ && input.next === 45) {
    eol(input);
    input.acceptToken(LineComment);
  } else if (next === 47 /* / */ && input.next === 42 /* * */) {
    // Nested block comment
    input.advance();
    for (let depth = 1; ; ) {
      const cur: number = input.next;
      if (input.next < 0) break;
      input.advance();
      if (cur === 42 && (input.next as number) === 47) {
        depth--;
        input.advance();
        if (!depth) break;
      } else if (cur === 47 && input.next === 42) {
        depth++;
        input.advance();
      }
    }
    input.acceptToken(BlockComment);
  } else if ((next | 32) === 101 /* e E */ && input.next === 39) {
    input.advance();
    readLiteral(input, 39, true);
    input.acceptToken(StringToken);
  } else if (next === 34 /* " */) {
    readLiteral(input, 34, false);
    input.acceptToken(QuotedIdentifier);
  } else if (next === 40) {
    input.acceptToken(ParenL);
  } else if (next === 41) {
    input.acceptToken(ParenR);
  } else if (next === 123) {
    input.acceptToken(BraceL);
  } else if (next === 125) {
    input.acceptToken(BraceR);
  } else if (next === 91) {
    input.acceptToken(BracketL);
  } else if (next === 93) {
    input.acceptToken(BracketR);
  } else if (next === 59) {
    input.acceptToken(Semi);
  } else if ((next | 32) === 98 /* b B */ && (input.next === 39 || input.next === 34)) {
    const quoteStyle = input.next;
    input.advance();
    readBits(input, quoteStyle);
    input.acceptToken(Bits);
  } else if ((next === 48 /* 0 */ && (input.next | 32) === 120) /* x X */ || ((next | 32) === 120 && input.next === 39)) {
    const quoted = input.next === 39;
    input.advance();
    while ((cls(input.next) & C_HEX) !== 0) input.advance();
    if (quoted && input.next === 39) input.advance();
    input.acceptToken(NumberToken);
  } else if (next === 46 /* . */ && (cls(input.next) & C_DIGIT) !== 0) {
    readNumber(input, true);
    input.acceptToken(NumberToken);
  } else if (next === 46) {
    input.acceptToken(Dot);
  } else if ((cls(next) & C_DIGIT) !== 0) {
    readNumber(input, false);
    input.acceptToken(NumberToken);
  } else if ((cls(next) & C_OP) !== 0) {
    while ((cls(input.next) & C_OP) !== 0) input.advance();
    input.acceptToken(Operator);
  } else if (next === 63 /* ? — specialVar */) {
    if (input.next === 63) input.advance();
    readWordOrQuoted(input);
    input.acceptToken(SpecialVar);
  } else if (next === 58 || next === 44 /* : , */) {
    input.acceptToken(Punctuation);
  } else if ((cls(next) & C_ALPHA) !== 0) {
    const word = readWord(input, String.fromCharCode(next));
    input.acceptToken(input.next === 46 || input.peek(-word.length - 1) === 46 ? Identifier : (WORDS[word.toLowerCase()] ?? Identifier));
  }
});
