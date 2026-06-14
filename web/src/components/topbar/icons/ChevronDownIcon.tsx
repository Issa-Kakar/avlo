import type React from 'react';

/**
 * Solid down-chevron, Mural geometry — the dropdown trigger glyph.
 * 24-viewBox, `currentColor` fill: parent controls the tint
 * (rest = engaged dark, open = white via the trigger button's flip).
 */
export const ChevronDownIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    <path d="M12.707 16.23a1 1 0 0 1-1.414 0l-5.55-5.55a1 1 0 0 1 0-1.415l.494-.495a1 1 0 0 1 1.414 0l4.137 4.137a.3.3 0 0 0 .424 0L16.35 8.77a1 1 0 0 1 1.414 0l.495.495a1 1 0 0 1 0 1.414l-5.55 5.55Z" />
  </svg>
);
