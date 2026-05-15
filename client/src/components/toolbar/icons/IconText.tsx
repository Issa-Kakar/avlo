import type React from 'react';

// Filled rounded rect with Mural's T letterform cut out via evenodd.
// T path computed from Mural's Lottie transforms: matrix(0.4081,0,0,0.4081,2.2676,2.3936) × matrix(2.5,0,0,2.5,24.006,24.085)
// Combined: vx = 1.02025 * localX + 12.0644, vy = 1.02025 * localY + 12.2227
export const IconText: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path
      fillRule="evenodd"
      d="M4 1.5a2.5 2.5 0 0 0-2.5 2.5v16a2.5 2.5 0 0 0 2.5 2.5h16a2.5 2.5 0 0 0 2.5-2.5V4A2.5 2.5 0 0 0 20 1.5H4Zm10.9 15.67c0 .57-.51 1.04-1.11 1.04h-3.48c-.6 0-1.09-.47-1.09-1.04 0-.56.49-1.03 1.09-1.03h.47V8.31H8.55v.95c0 .57-.5 1.04-1.11 1.04-.6 0-1.09-.47-1.09-1.04V7.23c0-.55.49-.99 1.1-.99h9.24c.59 0 1.11.44 1.11.99v2.03c0 .57-.5 1.04-1.11 1.04-.6 0-1.09-.47-1.09-1.04v-.95h-2.26v7.83h.48c.6 0 1.09.47 1.09 1.03Z"
    />
  </svg>
);
