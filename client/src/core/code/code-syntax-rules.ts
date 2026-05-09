/**
 * Code Syntax Rules — Single source of truth for the Lezer-tag → S enum mapping.
 *
 * Consumers:
 *   - `code-theme.ts` derives `HighlightStyle.define` rules (CodeMirror DOM)
 *     from `SYNTAX_RULES` + `THEME.palette` + `isBold`.
 *   - `lezer-worker.ts` imports `STYLE_HIGHLIGHTER` (a custom Highlighter that
 *     returns the stringified S int directly). The worker callback recovers
 *     the int with `+classes | 0` — no `tagHighlighter`/`TAG_STYLE_INDEX`
 *     indirection.
 */

import type { Highlighter, Tag } from '@lezer/highlight';
import { tags } from '@lezer/highlight';
import { S } from './code-tokens';

export interface SyntaxRule {
  tags: Tag[];
  style: S;
}

export const SYNTAX_RULES: readonly SyntaxRule[] = [
  { tags: [tags.keyword, tags.operatorKeyword, tags.controlKeyword], style: S.KEYWORD },
  { tags: [tags.definitionKeyword], style: S.DEF_KW },
  { tags: [tags.moduleKeyword, tags.modifier, tags.meta], style: S.MODIFIER },
  {
    tags: [tags.string, tags.special(tags.string), tags.special(tags.brace), tags.escape, tags.regexp, tags.character],
    style: S.STRING,
  },
  { tags: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom], style: S.NUMBER },
  { tags: [tags.lineComment, tags.blockComment, tags.docComment], style: S.COMMENT },
  {
    tags: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.function(tags.definition(tags.variableName)),
      tags.className,
      tags.definition(tags.propertyName),
      tags.definition(tags.typeName),
    ],
    style: S.FUNCTION,
  },
  { tags: [tags.variableName, tags.self, tags.definition(tags.variableName), tags.labelName], style: S.VARIABLE },
  { tags: [tags.typeName, tags.propertyName, tags.tagName, tags.angleBracket, tags.namespace], style: S.TYPE },
  {
    tags: [
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
    style: S.OPERATOR,
  },
  {
    tags: [tags.derefOperator, tags.separator, tags.bracket, tags.squareBracket, tags.paren, tags.brace],
    style: S.DEFAULT,
  },
  { tags: [tags.attributeName], style: S.ATTRIBUTE },
  { tags: [tags.invalid], style: S.INVALID },
];

const TAG_TO_S = new Map<Tag, S>();
for (const r of SYNTAX_RULES) for (const t of r.tags) TAG_TO_S.set(t, r.style);

// Pre-stringified per-S labels so the Highlighter callback never allocates.
const _classCache: string[] = [];
for (const r of SYNTAX_RULES) _classCache[r.style] = String(r.style);

/**
 * Custom Lezer Highlighter — returns the stringified S enum value directly so
 * the worker callback recovers the int via `+classes | 0` with no indirection.
 *
 * Walks each tag's modifier `set` (matches `@lezer/highlight`'s `tagHighlighter`
 * semantics) so modifier tags like `tags.local(tags.variableName)` resolve to
 * their base tag's S. Returns on first match — single S int per span.
 */
export const STYLE_HIGHLIGHTER: Highlighter = {
  style(tagList) {
    for (let i = 0; i < tagList.length; i++) {
      const set = tagList[i].set;
      for (let j = 0; j < set.length; j++) {
        const s = TAG_TO_S.get(set[j]);
        if (s !== undefined) return _classCache[s];
      }
    }
    return null;
  },
};
