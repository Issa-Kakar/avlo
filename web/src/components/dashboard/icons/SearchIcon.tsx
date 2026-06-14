import type React from 'react';

// Top-bar search field leading glyph. Mural `search`.
export const SearchIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M1.5 9a7.5 7.5 0 1 1 13.857 3.981c-.272.434-.248 1.007.114 1.368l.325.326c.222.222.538.314.852.332a2.49 2.49 0 0 1 1.623.728l3.074 3.075a2.5 2.5 0 0 1-3.535 3.535l-3.075-3.074a2.49 2.49 0 0 1-.728-1.623c-.018-.314-.11-.63-.332-.852l-.643-.643c-.311-.31-.786-.376-1.192-.21A7.5 7.5 0 0 1 1.5 9ZM9 4.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z"
      fillRule="evenodd"
      clipRule="evenodd"
    />
  </svg>
);
