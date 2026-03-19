import React from 'react';

/**
 * Hamburger menu + left-pointing filled chevron — indicates expandable left sidebar.
 *
 * All elements are filled paths (no strokes) for crisp rendering.
 * Chevron: 8.5w × 7h polygon with 2-unit arm thickness tapering to tip.
 * Lines: 2-unit-tall pills with r=1 rounded ends.
 *
 * Vertical layout: y=0–7 (chevron), y=2.5–4.5 (top line), y=11–13 (mid), y=19.5–21.5 (bot).
 * Fills ~90% of viewBox height. Line spacing: 8.5 units symmetric.
 */
export const SidebarIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    fill="currentColor"
    {...props}
  >
    {/* Left-pointing chevron — filled polygon, centered at y=3.5 */}
    <path d="M9.5 0 L1 3.5 L9.5 7 L9.5 5 L4.5 3.5 L9.5 2 Z" />
    {/* Top line — pill, cy=3.5, x=12→22 */}
    <path d="M13 2.5 H21 A1 1 0 0 1 21 4.5 H13 A1 1 0 0 1 13 2.5 Z" />
    {/* Mid line — pill, cy=12, x=1→22 */}
    <path d="M2 11 H21 A1 1 0 0 1 21 13 H2 A1 1 0 0 1 2 11 Z" />
    {/* Bot line — pill, cy=20.5, x=1→22 */}
    <path d="M2 19.5 H21 A1 1 0 0 1 21 21.5 H2 A1 1 0 0 1 2 19.5 Z" />
  </svg>
);
