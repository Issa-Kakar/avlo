import type React from 'react';

// Sidebar nav — Recent. Mural `recent` (clock) glyph.
export const RecentIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M12 1C7.417 1 1 3.75 1 12s5.5 11 11 11 11-2.75 11-11S16.583 1 12 1Zm1.125 5.5a1.125 1.125 0 0 0-2.25 0V12c0 .298.118.585.33.796l2 2a1.125 1.125 0 0 0 1.59-1.591l-1.67-1.671V6.5Z"
      fillRule="evenodd"
      clipRule="evenodd"
    />
  </svg>
);
