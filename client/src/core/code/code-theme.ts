/**
 * Code Theme — CodeMirror theme extensions (Sweet Dracula dark theme + syntax highlighting).
 *
 * Lazy-loaded and cached. Reads colors from `THEME` (palette + chrome) in
 * `code-tokens.ts`; the `HighlightStyle.define` rule list is derived from
 * `SYNTAX_RULES` (in `code-syntax-rules.ts`) + `THEME.palette` so the canvas
 * renderer and the CodeMirror DOM share one source of truth for Lezer-tag → S
 * → color. No bold or italic — Sweet Dracula's emphasis is color-only.
 */

import { SYNTAX_RULES } from './code-syntax-rules';
import { CODE_FONT_FAMILY, LINE_HEIGHT_MULT, S, THEME } from './code-tokens';

let _themeExtensions: unknown[] | null = null;

export async function getCodeMirrorExtensions(): Promise<unknown[]> {
  if (_themeExtensions) return _themeExtensions;

  const [{ EditorView }, { syntaxHighlighting, HighlightStyle }] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/language'),
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
        paddingLeft: 'var(--c-gl)',
      },
      '.cm-content': {
        fontFamily: `'${CODE_FONT_FAMILY}', monospace`,
        padding: '0',
      },
      '.cm-line': {
        padding: '0 var(--c-pr) 0 var(--c-gr)',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0',
        fontFamily: `'${CODE_FONT_FAMILY}', monospace`,
        fontFeatureSettings: '"tnum"',
        textAlign: 'right',
        minWidth: 'var(--c-gw)',
      },
      '.cm-cursor': { borderLeftColor: THEME.chrome.caret },
      '.cm-activeLine': { backgroundColor: THEME.chrome.lineHl },
      '.cm-activeLineGutter': {
        backgroundColor: THEME.chrome.lineHl,
        marginLeft: 'calc(-1 * var(--c-gl))',
        paddingLeft: 'var(--c-gl)',
      },
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

  const codeHighlightStyle = syntaxHighlighting(
    HighlightStyle.define(
      SYNTAX_RULES.map((r) => ({
        tag: r.tags,
        color: THEME.palette[r.style],
      })),
    ),
  );

  _themeExtensions = [codeEditorTheme, codeHighlightStyle];
  return _themeExtensions;
}
