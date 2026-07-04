/**
 * CodeMirror editor support for the vendored standard-SQL parser — the
 * LRLanguage layer of @codemirror/lang-sql@6.10.0 (MIT) minus dialects,
 * completion and folding.
 *
 * MAIN-THREAD ONLY: imports @codemirror/language. Reached exclusively via
 * dynamic import from CodeTool's `loadLangExt` — never from the worker graph
 * and never statically from the main bundle.
 */

import { continuedIndent, indentNodeProp, LanguageSupport, LRLanguage } from '@codemirror/language';

import { parser } from './index';

const sqlLanguage = LRLanguage.define({
  name: 'sql',
  parser: parser.configure({
    props: [indentNodeProp.add({ Statement: continuedIndent() })],
  }),
  languageData: {
    commentTokens: { line: '--', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', "'", '"', '`'] },
  },
});

export function sql(): LanguageSupport {
  return new LanguageSupport(sqlLanguage);
}
