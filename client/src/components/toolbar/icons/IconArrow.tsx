import type React from 'react';

// Connector tool button: chunky diagonal arrow pointing top-right — shaft + arrowhead.
export const IconArrow: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <rect x="0.5" y="10" width="20" height="4" rx="2" transform="rotate(-45 12 12)" />
    <path d="M13.5 2h7a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-3 0V7.1L15.6 10.5a1.5 1.5 0 0 1-2.1-2.1L16.9 5H13.5a1.5 1.5 0 0 1 0-3Z" />
  </svg>
);
