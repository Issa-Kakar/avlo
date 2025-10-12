// Quadratic Bézier smoothing of Perfect Freehand outline points → SVG path string.
// Adapted from the perfect-freehand README's helper (keeps full precision).
// This creates smooth curves instead of faceted lineTo segments.
export function getSvgPathFromStroke(
  points: number[][],
  closed = true
): string {
  const len = points.length;
  if (len < 2) return '';

  const avg = (a: number, b: number) => (a + b) / 2;

  // Handle degenerate case with exactly 2 points
  if (len === 2) {
    const [a, b] = points;
    return `M${a[0]},${a[1]} L${b[0]},${b[1]}${closed ? ' Z' : ''}`;
  }

  // Build smooth quadratic Bézier path
  let a = points[0];
  let b = points[1];
  let c = points[2];

  // Start with M (moveTo), then Q (quadratic curve) to midpoint
  let d = `M${a[0]},${a[1]} Q${b[0]},${b[1]} ${avg(b[0], c[0])},${avg(b[1], c[1])} T`;

  // Continue with T (smooth quadratic) commands for continuous tangents
  for (let i = 2; i < len - 1; i++) {
    a = points[i];
    b = points[i + 1];
    d += `${avg(a[0], b[0])},${avg(a[1], b[1])} `;
  }

  // Close the path if requested
  if (closed) d += 'Z';
  return d;
}