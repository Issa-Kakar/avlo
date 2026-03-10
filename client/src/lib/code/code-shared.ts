/**
 * Code Shared — Style enum, packed RunSpans, color palette, and gap-fill
 * algorithm shared between code-system.ts (main thread) and lezer-worker.ts.
 *
 * RunSpans replaces TextRun[]: a Uint16Array of [offset, length, styleIndex]
 * triples per source line. 20x less memory, zero per-run object allocation.
 */

// ============================================================================
// STYLE ENUM — 13 styles, fits in a byte
// ============================================================================

/** const enum inlines to numeric literals at compile time — zero runtime cost. */
export const enum S {
  DEFAULT = 0,
  KEYWORD = 1,
  DEF_KW = 2,
  MODIFIER = 3,
  STRING = 4,
  NUMBER = 5,
  COMMENT = 6,
  FUNCTION = 7,
  VARIABLE = 8,
  TYPE = 9,
  OPERATOR = 10,
  ATTRIBUTE = 11,
  INVALID = 12,
}

// ============================================================================
// PALETTE — index = S value. Single source of truth for colors.
// ============================================================================

export const PALETTE: readonly string[] = [
  '#E0E0E0', // DEFAULT
  '#2BF1DC', // KEYWORD
  '#F8FBB1', // DEF_KW
  '#2BF1DC', // MODIFIER
  '#8DFF8E', // STRING
  '#62E9BD', // NUMBER
  '#AEAEAE', // COMMENT
  '#A3EBFF', // FUNCTION
  '#B683CA', // VARIABLE
  '#60A4F1', // TYPE
  '#2BF1DC', // OPERATOR
  '#7BACCA', // ATTRIBUTE
  '#FF5370', // INVALID
];

/** Bold: only KEYWORD, DEF_KW, MODIFIER (indices 1-3). */
export function isBold(s: number): boolean {
  return s >= 1 && s <= 3;
}

// ============================================================================
// CONSTANTS — CoolGlow palette (chrome)
// ============================================================================

export const CODE_BG = '#060521';
export const CODE_DEFAULT = '#E0E0E0';
export const CODE_GUTTER = '#E0E0E090';
export const CODE_SELECTION = '#122BBB';
export const CODE_LINE_HL = '#FFFFFF0F';
export const CODE_CARET = '#FFFFFFA6';

// Token color constants — kept for CM theme + sync tokenizer keyword sets
export const KEYWORD = '#2BF1DC';
export const DEF_KEYWORD = '#F8FBB1';
export const MODIFIER = '#2BF1DC';
export const STRING = '#8DFF8E';
export const NUMBER = '#62E9BD';
export const COMMENT = '#AEAEAE';
export const FUNCTION = '#A3EBFF';
export const VARIABLE = '#B683CA';
export const TYPE = '#60A4F1';
export const OPERATOR = '#2BF1DC';
export const ATTRIBUTE = '#7BACCA';

export const CODE_FONT_FAMILY = 'JetBrains Mono';

/** TAG_STYLES map — derived from PALETTE. Used by CM HighlightStyle. */
export const TAG_STYLES: Record<string, { color: string; bold?: boolean }> = {
  keyword: { color: PALETTE[S.KEYWORD], bold: true },
  'def-keyword': { color: PALETTE[S.DEF_KW], bold: true },
  modifier: { color: PALETTE[S.MODIFIER], bold: true },
  string: { color: PALETTE[S.STRING] },
  number: { color: PALETTE[S.NUMBER] },
  comment: { color: PALETTE[S.COMMENT] },
  function: { color: PALETTE[S.FUNCTION] },
  variable: { color: PALETTE[S.VARIABLE] },
  type: { color: PALETTE[S.TYPE] },
  operator: { color: PALETTE[S.OPERATOR] },
  attribute: { color: PALETTE[S.ATTRIBUTE] },
  deref: { color: PALETTE[S.DEFAULT] },
  punctuation: { color: PALETTE[S.DEFAULT] },
  invalid: { color: PALETTE[S.INVALID] },
};

/** Maps Lezer tag class names to S enum values. Used by worker. */
export const TAG_STYLE_INDEX: Record<string, number> = {
  keyword: S.KEYWORD,
  'def-keyword': S.DEF_KW,
  modifier: S.MODIFIER,
  string: S.STRING,
  number: S.NUMBER,
  comment: S.COMMENT,
  function: S.FUNCTION,
  variable: S.VARIABLE,
  type: S.TYPE,
  operator: S.OPERATOR,
  attribute: S.ATTRIBUTE,
  deref: S.DEFAULT,
  punctuation: S.DEFAULT,
  invalid: S.INVALID,
};

// ============================================================================
// RUNSPANS — flat packed [offset, length, style] triples
// ============================================================================

/**
 * A Uint16Array where length % 3 === 0. Each triple: [offset, length, styleIndex].
 * Concatenated triples cover the entire source line (no gaps).
 */
export type RunSpans = Uint16Array;

/** Empty line sentinel — reused, no allocation. */
export const EMPTY_SPANS = new Uint16Array(0);

// ============================================================================
// PACK: sparse triples → gap-filled RunSpans
// ============================================================================

/**
 * Pack sparse highlight triples into a gap-filled RunSpans covering the full line.
 *
 * @param lineLen - length of the source line
 * @param buf - flat buffer of [from, to, styleIndex] triples (length = count * 3)
 * @param count - number of triples in buf
 */
export function packRunSpans(lineLen: number, buf: number[], count: number): RunSpans {
  if (lineLen === 0) return EMPTY_SPANS;
  if (count === 0) {
    const r = new Uint16Array(3);
    r[0] = 0;
    r[1] = lineLen;
    r[2] = S.DEFAULT;
    return r;
  }

  // Pre-count: each highlight = 1 run, each gap = 1 run
  let runCount = 0;
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const from = buf[i * 3];
    const to = buf[i * 3 + 1];
    if (from > pos) runCount++; // gap
    if (to > from) runCount++; // highlight
    pos = to;
  }
  if (pos < lineLen) runCount++; // trailing gap

  const spans = new Uint16Array(runCount * 3);
  let wi = 0;
  pos = 0;
  for (let i = 0; i < count; i++) {
    const from = buf[i * 3];
    const to = buf[i * 3 + 1];
    const style = buf[i * 3 + 2];
    if (from > pos) {
      spans[wi++] = pos;
      spans[wi++] = from - pos;
      spans[wi++] = S.DEFAULT;
    }
    if (to > from) {
      spans[wi++] = from;
      spans[wi++] = to - from;
      spans[wi++] = style;
    }
    pos = to;
  }
  if (pos < lineLen) {
    spans[wi++] = pos;
    spans[wi++] = lineLen - pos;
    spans[wi++] = S.DEFAULT;
  }

  return spans;
}
