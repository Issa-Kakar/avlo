/**
 * Public types for the $P/$Q point-cloud recognizer.
 *
 * Internal point representation is `Float64Array` (interleaved xy) — see
 * `point-buffer.ts`. The public boundary uses `readonly Point[]`, the storage
 * format already held by `DrawingTool.points`.
 */

export type PerfectShapeKind = 'circle' | 'box' | 'diamond' | 'line';

export interface PerfectShapeMatch {
  kind: PerfectShapeKind;
  templateId: string;
  /** Lower is better. */
  distance: number;
}

export interface PerfectShapeRecognition {
  best: PerfectShapeMatch;
  /** Best match of a kind different from `best.kind`, used for margin. */
  secondBest: PerfectShapeMatch | null;
  ambiguous: boolean;
  /** 0..1, higher = more separation between best and the next-best different kind. */
  margin: number;
  /** All matches sorted ascending by distance. */
  all: PerfectShapeMatch[];
}

export interface RecognizerOpts {
  /** Resample count. Defaults to PDOLLAR_CONFIG.NUM_POINTS (32). */
  n?: number;
  /** Greedy step exponent. Defaults to PDOLLAR_CONFIG.EPSILON (0.5). */
  epsilon?: number;
  /** Separation gate. Defaults to PDOLLAR_CONFIG.MIN_MARGIN (0.10). */
  minMargin?: number;
  /** If end-start distance ≤ ratio × bbox-diagonal, close path. Defaults to 0.12. */
  closeEpsRatio?: number;
}
