import type React from 'react';

// Per-row "Canvas options" trigger — Mural `moreVertical` (three rounded dots).
export const KebabIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    <path d="M12 6.903a2.445 2.445 0 1 1 0-4.89 2.445 2.445 0 0 1 0 4.89Zm0 7.542a2.445 2.445 0 1 1 0-4.89 2.445 2.445 0 0 1 0 4.89Zm-2.445 5.097a2.445 2.445 0 1 0 4.89 0 2.445 2.445 0 0 0-4.89 0Z" />
  </svg>
);
