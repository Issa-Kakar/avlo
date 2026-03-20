import React from 'react';

/**
 * Hamburger menu icon — three horizontal lines.
 *
 * All elements are filled paths (no strokes) for crisp rendering.
 * Lines: 2-unit-tall pills with r=1 rounded ends at cy=5.5, 12, 18.5.
 * Compact spacing (6.5 units), shifted down for optical alignment with "avlo" x-height.
 */
export const SidebarIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    {/* Top line — pill, cy=5.5 */}
    <path d="M2 4.5 H21 A1 1 0 0 1 21 6.5 H2 A1 1 0 0 1 2 4.5 Z" />
    {/* Mid line — pill, cy=12 */}
    <path d="M2 11 H21 A1 1 0 0 1 21 13 H2 A1 1 0 0 1 2 11 Z" />
    {/* Bot line — pill, cy=18.5 */}
    <path d="M2 17.5 H21 A1 1 0 0 1 21 19.5 H2 A1 1 0 0 1 2 17.5 Z" />
  </svg>
);
