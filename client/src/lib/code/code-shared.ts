/**
 * Code Shared — Types, constants, and gap-fill algorithm shared between
 * code-system.ts (main thread) and lezer-worker.ts (worker thread).
 */

// ============================================================================
// TYPES
// ============================================================================

/** A run of text with uniform styling. Concatenated runs cover the full line. */
export interface TextRun {
  text: string;
  color: string;
  bold: boolean;
}

/** Sparse highlight from tokenizer — gaps between highlights are default-colored. */
export interface SparseHighlight {
  from: number;
  to: number;
  color: string;
  bold: boolean;
}

// ============================================================================
// CONSTANTS — CoolGlow palette (ThemeMirror)
// ============================================================================

// Chrome
export const CODE_BG           = '#060521';
export const CODE_DEFAULT      = '#E0E0E0';
export const CODE_GUTTER       = '#E0E0E090';
export const CODE_SELECTION    = '#122BBB';
export const CODE_LINE_HL      = '#FFFFFF0F';
export const CODE_CARET        = '#FFFFFFA6';

// Token colors
export const KEYWORD           = '#2BF1DC';     // control flow (if/else/return/for/while)
export const DEF_KEYWORD       = '#F8FBB1';     // definitions (const/let/var/function/class)
export const MODIFIER          = '#2BF1DC';     // modifiers + module — merged with KEYWORD cyan
export const STRING            = '#8DFF8E';
export const NUMBER            = '#62E9BD';
export const COMMENT           = '#AEAEAE';
export const FUNCTION          = '#A3EBFF';
export const VARIABLE          = '#B683CA';
export const TYPE              = '#60A4F1';
export const OPERATOR          = '#2BF1DC';     // matches KEYWORD
export const ATTRIBUTE         = '#7BACCA';

export const CODE_FONT_FAMILY = 'JetBrains Mono';

/** TAG_STYLES map — maps token class names to style. Used by worker + CM theme. */
export const TAG_STYLES: Record<string, { color: string; bold?: boolean }> = {
  keyword:       { color: KEYWORD, bold: true },
  'def-keyword': { color: DEF_KEYWORD, bold: true },
  modifier:      { color: MODIFIER, bold: true },
  string:        { color: STRING },
  number:        { color: NUMBER },
  comment:       { color: COMMENT },
  function:      { color: FUNCTION },
  variable:      { color: VARIABLE },
  type:          { color: TYPE },
  operator:      { color: OPERATOR },
  attribute:     { color: ATTRIBUTE },
  deref:         { color: CODE_DEFAULT },
  punctuation:   { color: CODE_DEFAULT },
  invalid:       { color: '#FF5370' },
};

// ============================================================================
// GAP-FILL: highlightsToRuns
// ============================================================================

/**
 * Convert sparse highlights into a complete TextRun[] partition of lineText.
 * Invariant: runs.map(r => r.text).join('') === lineText
 * Every character appears in exactly one run — no missing characters.
 */
export function highlightsToRuns(lineText: string, highlights: SparseHighlight[]): TextRun[] {
  if (lineText.length === 0) return [];
  if (highlights.length === 0) return [{ text: lineText, color: CODE_DEFAULT, bold: false }];

  const runs: TextRun[] = [];
  let pos = 0;

  for (const h of highlights) {
    // Gap before this highlight → default run
    if (h.from > pos) {
      runs.push({ text: lineText.slice(pos, h.from), color: CODE_DEFAULT, bold: false });
    }
    // The highlight itself
    if (h.to > h.from) {
      runs.push({ text: lineText.slice(h.from, h.to), color: h.color, bold: h.bold });
    }
    pos = h.to;
  }

  // Gap after last highlight → default run
  if (pos < lineText.length) {
    runs.push({ text: lineText.slice(pos), color: CODE_DEFAULT, bold: false });
  }

  return runs;
}

// ============================================================================
// RUN SLICING (for wrapping)
// ============================================================================

/**
 * Slice runs to character range [from, to) within the source line.
 * Returns new TextRun[] covering exactly that range.
 */
export function sliceRuns(runs: TextRun[], from: number, to: number): TextRun[] {
  const result: TextRun[] = [];
  let pos = 0;

  for (const run of runs) {
    const runEnd = pos + run.text.length;
    if (runEnd <= from) {
      pos = runEnd;
      continue;
    }
    if (pos >= to) break;

    const sliceFrom = Math.max(0, from - pos);
    const sliceTo = Math.min(run.text.length, to - pos);
    if (sliceTo > sliceFrom) {
      result.push({ text: run.text.slice(sliceFrom, sliceTo), color: run.color, bold: run.bold });
    }
    pos = runEnd;
  }

  return result;
}

// ============================================================================
// DEV ASSERTION
// ============================================================================

export function assertRunsCoverLine(lineText: string, runs: TextRun[]): void {
  const joined = runs.map((r) => r.text).join('');
  if (joined !== lineText) {
    console.error(
      '[code-shared] Run coverage mismatch!\n' +
        `  expected: ${JSON.stringify(lineText)}\n` +
        `  got:      ${JSON.stringify(joined)}`,
    );
  }
}
