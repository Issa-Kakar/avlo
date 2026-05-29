import type React from 'react';

/**
 * Solid right-chevron, Mural geometry — submenu / popout indicator.
 * 24-viewBox, `currentColor` fill: tints with the parent row's text color.
 */
export const ChevronRightIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    <path d="M16.23 11.293a1 1 0 0 1 0 1.414l-5.55 5.55a1 1 0 0 1-1.415 0l-.495-.494a1 1 0 0 1 0-1.414l4.137-4.137a.3.3 0 0 0 0-.424L8.77 7.65a1 1 0 0 1 0-1.414l.495-.495a1 1 0 0 1 1.414 0l5.55 5.55Z" />
  </svg>
);
