import type React from 'react';

/**
 * Star — Mural `favoriteEmpty`. `filled` draws the outer silhouette solid;
 * unfilled draws the same outer contour plus the inner contour (evenodd) as a
 * thick outline. Both share the exact silhouette/size so the glyph keeps its
 * shape when toggling starred state — only the fill differs.
 */
const STAR_INNER =
  'M12.345 3.192a1.08 1.08 0 0 0-1.007.69l-.987 3.945a1.94 1.94 0 0 1-2.054 1.48l-4.065-.32h-.003a1.08 1.08 0 0 0-.65 1.999l.003.001 3.5 2.142.018.012a2 2 0 0 1 .76 2.34l-.008.021-1.568 3.79a1.082 1.082 0 0 0 1.039 1.493c.242-.009.474-.1.658-.256l3.116-2.664.018-.013a2 2 0 0 1 2.46 0l.017.013 3.122 2.66a1.08 1.08 0 0 0 1.69-1.236v-.002l-1.566-3.785-.008-.02a2 2 0 0 1 .76-2.34l.019-.013 3.5-2.143a1.08 1.08 0 0 0-.642-1.999h-.001l-4.073.32a1.94 1.94 0 0 1-2.054-1.48l-.987-3.944a1.08 1.08 0 0 0-1.007-.691Z';
const STAR_OUTER =
  'M10.559 1.762a3.08 3.08 0 0 1 4.696 1.5l.014.042 1.002 4.006 4.04-.317h.003a3.08 3.08 0 0 1 1.837 5.7l-3.44 2.106 1.545 3.734a3.08 3.08 0 0 1-4.827 3.524l-.008-.006-3.076-2.621-3.067 2.621a3.08 3.08 0 0 1-4.842-3.523l1.543-3.729-3.439-2.105a3.08 3.08 0 0 1 1.85-5.7h.002l4.028.316 1.002-4.006.014-.042a3.08 3.08 0 0 1 1.124-1.5Z';
const STAR_OUTLINE = STAR_INNER + STAR_OUTER.replace('M10.559 1.762', 'm-1.786-1.43');

export const StarIcon: React.FC<React.SVGProps<SVGSVGElement> & { filled?: boolean }> = ({ filled = false, ...props }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    <path d={filled ? STAR_OUTER : STAR_OUTLINE} fillRule="evenodd" clipRule="evenodd" />
  </svg>
);
