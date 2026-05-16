import type React from 'react';

// Connector inspector variant icons. Fill-based (no strokes) at a native 20-unit
// viewBox so they're pixel-aligned at the inspector's 20px render size. The
// straight-arrow variant reuses `IconArrow` (24-unit; CSS-scaled down) — see
// `ConnectorInspector.tsx`'s VARIANT_ICONS map.

// Diagonal pill, top-right → bottom-left. Same / axis as IconArrow's shaft,
// minus the arrowhead. Conveys "straight, no caps". The large-arc caps protrude
// past the chord for a slightly bulged silhouette (radius ~2.2× the half-width).
export const IconConnectorLine: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M15.366 6.403L6.403 15.366A3.333 3.333 0 1 1 4.634 13.598L13.598 4.634A3.333 3.333 0 1 1 15.366 6.403Z" />
  </svg>
);

// Right-then-down elbow with a flag-style arrowhead on the right tip. The two
// outer corners are rounded; the two inner corners stay sharp. Conveys
// "orthogonal connector with end-cap arrow".
export const IconConnectorElbow: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M10.833 2.5H14.167V0L20 3.75L14.167 7.5V5H10.833V17.5A2.5 2.5 0 0 1 8.333 20H0V17.5H8.333V5A2.5 2.5 0 0 1 10.833 2.5Z" />
  </svg>
);
