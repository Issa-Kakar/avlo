/** Clamp `x` to the closed interval [`min`, `max`]. */
export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

/** Clamp `x` to [0, 1]. Hot enough that the explicit form pays for itself. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Squared 2D length. Avoids `sqrt`; use for distance comparisons. */
export function hypot2(dx: number, dy: number): number {
  return dx * dx + dy * dy;
}
