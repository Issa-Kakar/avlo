/** Main ↔ worker message contract for the lock-veil layer. Discriminated by `t`. */

export const VEIL_INIT = 0;
export const VEIL_CAMERA = 1;
export const VEIL_BOXES = 2;

export type VeilMsg =
  /** One-shot: hand the transferred canvas to the worker. */
  | { t: typeof VEIL_INIT; canvas: OffscreenCanvas }
  /** Camera + device size — posted per camera-store fire while locks are held. */
  | { t: typeof VEIL_CAMERA; s: number; x: number; y: number; d: number; w: number; h: number }
  /** Full replace of the locked world bboxes — [minX,minY,maxX,maxY] × n, buffer transferred. */
  | { t: typeof VEIL_BOXES; b: Float64Array<ArrayBuffer>; n: number };
