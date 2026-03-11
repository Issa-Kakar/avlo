/**
 * Code Theme — CodeMirror theme extensions (CoolGlow dark theme + syntax highlighting).
 *
 * Lazy-loaded and cached. No dependency on code-system.ts.
 */

import {
  CODE_BG,
  CODE_DEFAULT,
  CODE_GUTTER,
  CODE_SELECTION,
  CODE_LINE_HL,
  CODE_CARET,
  CODE_FONT_FAMILY,
  LINE_HEIGHT_MULT,
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
} from './code-tokens';

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
        paddingRight: 'var(--c-gr)',
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
