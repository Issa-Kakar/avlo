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
// CONSTANTS — Dark theme palette (One Dark inspired)
// ============================================================================

export const CODE_BG = '#282c34';
export const CODE_DEFAULT = '#abb2bf';
export const CODE_GUTTER = '#636d83';

export const KEYWORD = '#c678dd';
export const STRING = '#98c379';
export const NUMBER = '#d19a66';
export const COMMENT = '#5c6370';
export const FUNCTION = '#61afef';
export const VARIABLE = '#e06c75';
export const TYPE = '#e5c07b';
export const OPERATOR = '#56b6c2';

export const CODE_FONT_FAMILY = 'JetBrains Mono';

/** TAG_STYLES map — maps token class names to style. Used by worker + CM theme. */
export const TAG_STYLES: Record<string, { color: string; bold?: boolean }> = {
  keyword: { color: KEYWORD, bold: true },
  string: { color: STRING },
  number: { color: NUMBER },
  comment: { color: COMMENT },
  function: { color: FUNCTION },
  variable: { color: VARIABLE },
  type: { color: TYPE },
  operator: { color: OPERATOR },
  punctuation: { color: CODE_DEFAULT },
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
