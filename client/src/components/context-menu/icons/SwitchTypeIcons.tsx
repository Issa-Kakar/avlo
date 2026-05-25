import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

// Mural `switchType` glyph — two stacked arrows wrapping a target ring.
// Trigger for the rightmost type-switch dropdown on shape/text/note bars.
export const IconSwitchType: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M3.354 4.354a.5.5 0 0 1 0-.708L6.146.854A.5.5 0 0 1 7 1.207V3h8.5a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5H7v1.793a.5.5 0 0 1-.854.353L3.354 4.354ZM17 21v1.793a.5.5 0 0 0 .854.353l2.792-2.793a.5.5 0 0 0 0-.707l-2.793-2.793a.5.5 0 0 0-.853.354V19H8.5a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5H17Z" />
    <path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm-3 5a3 3 0 1 1 6 0 3 3 0 0 1-6 0Z" fillRule="evenodd" clipRule="evenodd" />
  </svg>
);

// Outlined shape glyphs for the grid — stroke=2 in a 20-unit viewBox, the
// same chunky line weight as the toolbar's `IconShapes` (1.992 in a 24-unit
// viewBox renders 1:1 at 20px CSS). Closed paths (rect/ellipse/polygon) use
// strokeLinejoin=round for softer corners on diamond/triangle.

export const IconSwitchTypeRect: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" {...props}>
    <rect x="2" y="2" width="16" height="16" />
  </svg>
);

export const IconSwitchTypeCircle: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" {...props}>
    <circle cx="10" cy="10" r="8" />
  </svg>
);

export const IconSwitchTypeDiamond: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M10 2L18 10L10 18L2 10Z" />
  </svg>
);

export const IconSwitchTypeTriangle: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M10 2.5L18.5 18.5L1.5 18.5Z" />
  </svg>
);

export const IconSwitchTypeRoundedRect: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" {...props}>
    <rect x="2" y="2" width="16" height="16" rx="4" />
  </svg>
);
