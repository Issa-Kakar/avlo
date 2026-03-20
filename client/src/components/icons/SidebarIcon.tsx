import React from 'react';

/**
 * Hamburger menu icon — three horizontal lines.
 *
 * All elements are filled paths (no strokes) for crisp rendering.
 * Lines: 2-unit-tall pills with r=1 rounded ends at y=3.5, 12, 20.5.
 * Spacing: 8.5 units symmetric. Full-width x=2→22.
 */
export const SidebarIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    {/* Top line — pill, cy=3.5 */}
    <path d="M2 2.5 H21 A1 1 0 0 1 21 4.5 H2 A1 1 0 0 1 2 2.5 Z" />
    {/* Mid line — pill, cy=12 */}
    <path d="M2 11 H21 A1 1 0 0 1 21 13 H2 A1 1 0 0 1 2 11 Z" />
    {/* Bot line — pill, cy=20.5 */}
    <path d="M2 19.5 H21 A1 1 0 0 1 21 21.5 H2 A1 1 0 0 1 2 19.5 Z" />
  </svg>
);
