import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Overlapping circle + rect (kind: shapes) */
export const IconShapes = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
    <rect x="1.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="10.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

/** Pen nib (kind: strokes) */
export const IconPenStroke = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
    <path
      d="M11.5 2.5L13.5 4.5L5.5 12.5L2.5 13.5L3.5 10.5L11.5 2.5Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Routed path with endpoint dot + arrowhead (kind: connectors) */
export const IconConnectorLine = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
    <circle cx="3" cy="12" r="1.5" fill="currentColor" />
    <path
      d="M3 10.5V6.5C3 5.4 3.9 4.5 5 4.5H11"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <path d="M10 2L13 4.5L10 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** T with baseline (kind: text) */
export const IconTextType = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
    <path d="M3 3.5H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M8 3.5V12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M5.5 12.5H10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
