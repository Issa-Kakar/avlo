/**
 * UAX #14 LINE-BREAK MACHINERY
 *
 * Pure char-code logic — no imports, no allocation. Given a string and a start
 * cursor, `nextSoftBreak` returns the end index of the first soft-wrap
 * sub-segment per the Unicode line-breaking algorithm (the subset relevant to
 * in-word break opportunities: HY, BA, SY, B2, OP, ZW, …).
 *
 * Consumed by the text-system flow engine (`placeWord`) and sticky-note's
 * `noteFlowCheck` to honor intra-word break points before falling back to
 * char-slicing. Self-contained leaf module — never the source of a layout bug.
 */

// UAX#14 line-break classes used by `nextSoftBreak`. Values are arbitrary; only
// pairwise comparisons matter. AL is the default.
const LB_AL = 0;
const LB_NU = 1;
const LB_OP = 2;
const LB_CL = 3;
const LB_CP = 4;
const LB_EX = 5;
const LB_IS = 6;
const LB_SY = 7;
const LB_QU = 8;
const LB_HY = 9;
const LB_BA = 10;
const LB_SP = 11;
const LB_GL = 12;
const LB_ZW = 13;
const LB_WJ = 14;
const LB_CM = 15;
const LB_B2 = 16;

const LB_ASCII: Uint8Array = (() => {
  const a = new Uint8Array(128);
  for (let i = 0; i < 128; i++) a[i] = LB_AL;
  for (let i = 48; i <= 57; i++) a[i] = LB_NU; // 0–9
  // Whitespace — appears as its own token; classification matters only for
  // pairs straddling the same token (rare), but we set SP for completeness.
  a[9] = LB_SP;
  a[10] = LB_SP;
  a[11] = LB_SP;
  a[12] = LB_SP;
  a[13] = LB_SP;
  a[32] = LB_SP;
  // OP — open punctuation
  a[40] = LB_OP; // (
  a[91] = LB_OP; // [
  a[123] = LB_OP; // {
  // CP — close paren
  a[41] = LB_CP; // )
  // CL — close punctuation
  a[93] = LB_CL; // ]
  a[125] = LB_CL; // }
  // EX — exclamation/question
  a[33] = LB_EX; // !
  a[63] = LB_EX; // ?
  // IS — infix separators
  a[44] = LB_IS; // ,
  a[46] = LB_IS; // .
  a[58] = LB_IS; // :
  a[59] = LB_IS; // ;
  // SY — slashes
  a[47] = LB_SY; // /
  // HY — hyphen
  a[45] = LB_HY; // -
  // BA — break-after misc
  a[37] = LB_BA; // %
  // QU — quotes
  a[34] = LB_QU; // "
  a[39] = LB_QU; // '
  return a;
})();

function getLBClass(cc: number): number {
  if (cc < 128) return LB_ASCII[cc];
  if (cc === 0x00a0 || cc === 0x202f || cc === 0x2007) return LB_GL; // NBSP family → glue
  if (cc === 0xfeff || cc === 0x2060) return LB_WJ; // ZWNBSP, WJ → word joiner
  if (cc === 0x200b) return LB_ZW; // ZWSP → break opportunity (LB8)
  if (cc === 0x200c || cc === 0x200d) return LB_CM; // ZWNJ, ZWJ → combining
  if (cc === 0x2018 || cc === 0x2019 || cc === 0x201c || cc === 0x201d) return LB_QU; // smart quotes
  if (cc === 0x2014) return LB_B2; // em dash — UAX#14 B2 (break ÷ on both sides, LB17 keeps '——' together)
  // En dash is UAX#14 BA, but we keep it as HY so LB25 (HY × NU) keeps `5–10` glued.
  if (cc === 0x2013) return LB_HY;
  if (cc === 0x00ad) return LB_BA; // SHY
  return LB_AL;
}

/** Pairwise UAX#14 break check on already-classified LB classes.
 *
 *  Returns `true` iff there is a soft-wrap break opportunity between two
 *  adjacent code units whose classes are `prev` / `curr`. Encodes the same
 *  candidate-then-suppress decision tree that the original inline `nextSoftBreak`
 *  loop used.
 *
 *  Candidate rules (prev allows break-after, or curr opens break-before):
 *    HY/BA/SY/EX/CL/CP/ZW × * | * × OP | B2 × * | * × B2
 *  Suppressions are LB9, LB11, LB12, LB12a, LB13, LB14, LB17, LB19, LB25, LB30.
 *  IS is intentionally absent from the candidate list — see comment trail
 *  in the previous revision (LB29 + LB25 make post-IS breaks vanish for
 *  word-internal text).
 *
 *  Hot helper — JIT-inlinable, monomorphic (number, number) → boolean. */
function isBreakBetweenClasses(prev: number, curr: number): boolean {
  const prevAllows =
    prev === LB_HY ||
    prev === LB_BA ||
    prev === LB_SY ||
    prev === LB_EX ||
    prev === LB_CL ||
    prev === LB_CP ||
    prev === LB_ZW ||
    prev === LB_B2;
  const currOpensBreak = curr === LB_OP || curr === LB_B2;
  if (!prevAllows && !currOpensBreak) return false;

  if (curr === LB_CM) return false; // LB9: never split a grapheme cluster
  if (prev === LB_WJ || curr === LB_WJ) return false; // LB11
  if (prev === LB_GL) return false; // LB12
  if (curr === LB_GL && prev !== LB_SP && prev !== LB_BA && prev !== LB_HY) return false; // LB12a
  if (curr === LB_CL || curr === LB_CP || curr === LB_EX || curr === LB_IS || curr === LB_SY) return false; // LB13
  if (prev === LB_OP) return false; // LB14
  // LB17 is `B2 SP* × B2`. SP cannot appear within a word token (tokenizer splits on it),
  // so pairwise B2 × B2 is sufficient.
  if (prev === LB_B2 && curr === LB_B2) return false; // LB17
  if (prev === LB_QU || curr === LB_QU) return false; // LB19
  if ((prev === LB_HY || prev === LB_SY) && curr === LB_NU) return false; // LB25
  if ((prev === LB_AL || prev === LB_NU) && curr === LB_OP) return false; // LB30 (AL/NU × OP)
  if ((prev === LB_CL || prev === LB_CP) && (curr === LB_AL || curr === LB_NU)) return false; // LB30 (CL/CP × AL/NU)
  return true;
}

/** Find end of first soft-wrap sub-segment of `text[start..]` per UAX#14.
 *  Returns a char index in `text` (or `text.length` if no break). The returned
 *  index always lies on a grapheme boundary because LB9 suppresses break-before
 *  combining marks (CM, ZWJ, ZWNJ). */
export function nextSoftBreak(text: string, start: number = 0): number {
  for (let i = start + 1; i < text.length; i++) {
    if (isBreakBetweenClasses(getLBClass(text.charCodeAt(i - 1)), getLBClass(text.charCodeAt(i)))) return i;
  }
  return text.length;
}

/** Whether two adjacent code units form a UAX#14 break opportunity.
 *
 *  The text-system flow engine uses this at style-segment seams *inside* a
 *  word: the per-segment `nextSoftBreak` walk can't see across segments, so
 *  the seam itself has to be classified explicitly. Letter-letter (LB_AL ×
 *  LB_AL) seams return `false` even though a bold/regular split is structurally
 *  visible to the tokenizer — matching CSS, where styling never introduces a
 *  break opportunity. */
export function isBreakOpportunity(prevCharCode: number, currCharCode: number): boolean {
  return isBreakBetweenClasses(getLBClass(prevCharCode), getLBClass(currCharCode));
}
