import type React from 'react';

/**
 * Board glyph — Mural `muralsAll` (rounded square frame with an embedded
 * column, a circle, and a smaller square). 24-viewBox, `currentColor`
 * fill with `evenodd` so the inner shapes carve out of the frame.
 */
export const BoardIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M19 2a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3h14ZM7 7a1 1 0 1 1 0-2h3a1 1 0 1 1 0 2H7Zm6 2a3 3 0 1 0 6 0 3 3 0 0 0-6 0Zm-1.9 1a5.01 5.01 0 0 0 2.9 3.584V17a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h4.1Z"
      fillRule="evenodd"
      clipRule="evenodd"
    />
  </svg>
);
