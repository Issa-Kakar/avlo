import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Circle top-left + square bottom-right, square on top (kind: shapes) */
export const IconShapes = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    {/* Circle ring — visible 270° arc outside the square area */}
    <path d="M11 6A5 5 0 1 0 6 11L6 9.5A3.5 3.5 0 1 1 9.5 6Z" />
    {/* Square ring */}
    <path fillRule="evenodd" d="M6 6H15V15H6ZM7.5 7.5V13.5H13.5V7.5Z" />
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
    <path
      d="M10 2L13 4.5L10 7"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Angle brackets < > (kind: code) */
export const IconCodeBlock = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
    <path
      d="M5.5 3.5L2 8L5.5 12.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M10.5 3.5L14 8L10.5 12.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Mountain landscape (kind: images) */
export const IconImages = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5"
      stroke="currentColor" strokeWidth="1.5" />
    <circle cx="5" cy="6" r="1.25" fill="currentColor" />
    <path d="M2 12L5.5 8L8 10.5L10.5 7.5L14 12"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
