/**
 * Code Theme — CodeMirror theme extensions (Sweet Dracula dark theme + syntax highlighting).
 *
 * Lazy-loaded and cached. All `@codemirror/*` and `@lezer/highlight` imports are
 * dynamic so the main bundle has zero static dependency on the editor stack —
 * everything ships in the same code-split chunk that downloads on first
 * double-click of a code block.
 *
 * The `tags.X → S` rule list is built inline INSIDE `getCodeMirrorExtensions()`
 * (it needs the dynamically-imported `tags` object). `lezer-worker.ts` keeps its
 * own identical copy for `highlightTree`. Two sources of truth — deliberate, so
 * `@lezer/highlight` stays out of the main bundle. If you change a rule here,
 * change it there too.
 */

import { CODE_FONT_FAMILY, LINE_HEIGHT_MULT, S, THEME } from './code-tokens';

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
        backgroundColor: THEME.chrome.bg,
        color: THEME.palette[S.DEFAULT],
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
        backgroundColor: THEME.chrome.bg,
        color: THEME.chrome.gutter,
        border: 'none',
      },
      '.cm-content': {
        fontFamily: `'${CODE_FONT_FAMILY}', monospace`,
        padding: '0',
      },
      '.cm-line': {
        padding: '0 var(--c-pr) 0 var(--c-cl)',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 var(--c-gg, 0px) 0 var(--c-gi)',
        boxSizing: 'border-box',
        fontFamily: `'${CODE_FONT_FAMILY}', monospace`,
        fontFeatureSettings: '"tnum"',
        textAlign: 'right',
        minWidth: 'calc(var(--c-gw) + var(--c-gi) + var(--c-gg, 0px))',
      },
      '.cm-cursor': { borderLeftColor: THEME.chrome.caret },
      '.cm-activeLine': { backgroundColor: THEME.chrome.lineHl },
      '.cm-activeLineGutter': { backgroundColor: THEME.chrome.lineHl },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: THEME.chrome.selection,
      },
      // bracketMatching() decoration — editor-only UI marker for the active
      // brace pair during DOM editing. Independent of THEME and Lezer tagging:
      // transparent fill + plain white outline, nothing more.
      //
      // Selector MUST match `&.cm-focused .cm-matchingBracket` (not plain
      // `.cm-matchingBracket`) — `@codemirror/language`'s baseTheme uses that
      // higher-specificity selector to paint a teal `#328c8252` background,
      // which otherwise wins and shows as a teal film over the bracket. Same
      // story for the nonmatching variant.
      '&.cm-focused .cm-matchingBracket': {
        backgroundColor: 'transparent',
        outline: '1px solid #ffffff4d',
      },
      '&.cm-focused .cm-nonmatchingBracket': {
        backgroundColor: 'transparent',
        outline: `1px solid ${THEME.chrome.nonmatchBracket}80`,
        color: THEME.chrome.nonmatchBracket,
      },
      '.cm-searchMatch': { backgroundColor: THEME.chrome.searchMatch },
      '.cm-tooltip': {
        backgroundColor: THEME.chrome.bg,
        color: THEME.palette[S.DEFAULT],
        border: `1px solid ${THEME.chrome.selection}`,
      },
      '.cm-foldPlaceholder': {
        backgroundColor: THEME.chrome.selection,
        color: THEME.palette[S.DEFAULT],
        border: 'none',
      },
      '.cm-placeholder': {
        color: THEME.chrome.gutter,
        fontStyle: 'normal',
      },
    },
    { dark: true },
  );

  // Theme-side copy of the Lezer-tag → S mapping. `lezer-worker.ts` carries the
  // matching `WORKER_RULES` — change here and there together. The set walk that
  // resolves modifier tags is implemented by `HighlightStyle.define` itself.
  const codeHighlightStyle = syntaxHighlighting(
    HighlightStyle.define([
      { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword], color: THEME.palette[S.KEYWORD] },
      { tag: [tags.definitionKeyword], color: THEME.palette[S.STORAGE] },
      { tag: [tags.moduleKeyword, tags.modifier], color: THEME.palette[S.MODIFIER] },
      { tag: [tags.meta], color: THEME.palette[S.LANG_VAR] },
      {
        tag: [tags.string, tags.special(tags.string), tags.special(tags.brace), tags.regexp, tags.character, tags.attributeValue],
        color: THEME.palette[S.STRING],
      },
      { tag: [tags.escape], color: THEME.palette[S.OPERATOR] },
      {
        tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom, tags.color],
        color: THEME.palette[S.NUMBER],
      },
      { tag: [tags.lineComment, tags.blockComment, tags.docComment], color: THEME.palette[S.COMMENT] },
      {
        tag: [tags.function(tags.definition(tags.variableName)), tags.className, tags.definition(tags.typeName)],
        color: THEME.palette[S.FUNCTION_DEF],
      },
      // `definition(propertyName)` → DEFAULT explicitly. The set walk ordered
      // by Modifier.id hits this entry BEFORE `function(propertyName)` →
      // FUNCTION_CALL — one rule covers obj-literal keys, class fields, method
      // shorthand, AND class methods.
      { tag: [tags.definition(tags.propertyName)], color: THEME.palette[S.DEFAULT] },
      {
        tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
        color: THEME.palette[S.FUNCTION_CALL],
      },
      { tag: [tags.self], color: THEME.palette[S.LANG_VAR] },
      { tag: [tags.variableName, tags.definition(tags.variableName)], color: THEME.palette[S.VARIABLE] },
      { tag: [tags.typeName, tags.propertyName, tags.namespace], color: THEME.palette[S.TYPE] },
      { tag: [tags.tagName, tags.angleBracket], color: THEME.palette[S.KEYWORD] },
      { tag: [tags.unit], color: THEME.palette[S.KEYWORD] },
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
        color: THEME.palette[S.OPERATOR],
      },
      { tag: [tags.derefOperator, tags.function(tags.punctuation)], color: THEME.palette[S.OPERATOR] },
      { tag: [tags.bracket, tags.squareBracket, tags.paren, tags.brace], color: THEME.palette[S.DEFAULT] },
      { tag: [tags.attributeName, tags.labelName], color: THEME.palette[S.ATTRIBUTE] },
      { tag: [tags.invalid], color: THEME.palette[S.INVALID] },
    ]),
  );

  _themeExtensions = [codeEditorTheme, codeHighlightStyle];
  return _themeExtensions;
}
