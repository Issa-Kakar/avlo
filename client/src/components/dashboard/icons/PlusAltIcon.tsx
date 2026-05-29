import type React from 'react';

// New Canvas button leading glyph — plus-in-circle (Mural `plusAlt`).
export const PlusAltIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 25 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M12.5 1c-4.583 0-11 2.75-11 11s5.5 11 11 11 11-2.75 11-11-6.417-11-11-11Zm-1.625 13.125a.5.5 0 0 0-.5-.5H6.75c-.69 0-1.25-.56-1.25-1.25v-.75c0-.69.56-1.25 1.25-1.25h3.625a.5.5 0 0 0 .5-.5V6.25c0-.69.56-1.25 1.25-1.25h.75c.69 0 1.25.56 1.25 1.25v3.625a.5.5 0 0 0 .5.5h3.625c.69 0 1.25.56 1.25 1.25v.75c0 .69-.56 1.25-1.25 1.25h-3.625a.5.5 0 0 0-.5.5v3.625c0 .69-.56 1.25-1.25 1.25h-.75c-.69 0-1.25-.56-1.25-1.25v-3.625Z"
      fillRule="evenodd"
      clipRule="evenodd"
    />
  </svg>
);
