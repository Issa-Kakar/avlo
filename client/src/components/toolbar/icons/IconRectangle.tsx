import type React from 'react';

export const IconRectangle: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
  </svg>
);
