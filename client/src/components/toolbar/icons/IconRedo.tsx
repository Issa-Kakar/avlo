import type React from 'react';

// Curved arrow pointing up-right (horizontally mirrored undo).
export const IconRedo: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M11 1H12L16 5L12 9H11V6H5C3.3431 6 2 7.34315 2 9C2 10.6569 3.3431 12 5 12H12V14H5C2.2386 14 0 11.7614 0 9C0 6.23858 2.2386 4 5 4H11V1Z" />
  </svg>
);
