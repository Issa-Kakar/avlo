import type React from 'react';

/**
 * Export glyph — the Mural download SVG with the arrow flipped to point UP
 * (out of the tray), turning download into export/upload. Tray path is
 * untouched; arrow path was vertically mirrored around y=6.942:
 *   y_abs  → 13.884 − y_abs     (absolute coords)
 *   dy_rel → −dy_rel            (relative coords)
 *   sweep  → flipped (0↔1)      (mirror reverses winding)
 *
 * Tail now sits at the bottom (overlapping the tray top by 0.384 — same
 * visual continuity the original had between tip and tray). 24-viewBox,
 * `currentColor` fill.
 */
export const ExportIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    <path d="M13.252 11.884a1.25 1.25 0 1 1-2.5 0v-5.982L8.886 7.768a1.25 1.25 0 1 1-1.768-1.768l4-4a1.25 1.25 0 0 1 1.768 0l4 4a1.25 1.25 0 0 1-1.768 1.768l-1.866-1.866v5.982Z" />
    <path d="M22.002 11.5V20a2 2 0 0 1-2 2h-16a2 2 0 0 1-2-2v-8.5a1.5 1.5 0 0 1 3 0V13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1.5a1.5 1.5 0 0 1 3 0Z" />
  </svg>
);
