/**
 * Vendored standard-SQL Lezer parser — grammar tables generated from
 * `sql.grammar` (@codemirror/lang-sql@6.10.0, MIT), external tokenizer
 * specialized in `tokens.ts`, highlight props applied here (verbatim upstream
 * `sql.ts` styleTags block).
 *
 * WORKER-SAFE: imports @lezer/lr (via the generated file) + @lezer/highlight
 * only — never @codemirror/*. Shared by the lezer worker (REGISTRY) and the
 * CodeMirror editor (`support.ts`), so both sides tokenize identically forever.
 */

import { styleTags, tags as t } from '@lezer/highlight';

import { parser as grammarParser } from './sql.grammar.js';

export const parser = grammarParser.configure({
  props: [
    styleTags({
      Keyword: t.keyword,
      Type: t.typeName,
      Builtin: t.standard(t.name),
      Bits: t.number,
      Bytes: t.string,
      Bool: t.bool,
      Null: t.null,
      Number: t.number,
      String: t.string,
      Identifier: t.name,
      QuotedIdentifier: t.special(t.string),
      SpecialVar: t.special(t.name),
      LineComment: t.lineComment,
      BlockComment: t.blockComment,
      Operator: t.operator,
      'Semi Punctuation': t.punctuation,
      '( )': t.paren,
      '{ }': t.brace,
      '[ ]': t.squareBracket,
    }),
  ],
});
