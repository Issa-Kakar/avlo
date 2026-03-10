import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Line numbers 1/2 with code bars (kind: code lines toggle) */
export const IconCodeLines = (props: SvgProps) => (
  <svg viewBox="0 0 22 16" fill="currentColor" aria-hidden="true" {...props}>
    {/* "1" filled — flag + stem + base serif */}
    <path d="M0.5 3L2.5 0.5H4V5.5H5V7H1.5V5.5H2.5V2.5Z" />
    {/* "2" filled — 7-segment polygon */}
    <path d="M0.5 9H5V12.8H1.7V14.4H5V15.5H0.5V11.7H3.8V10.1H0.5Z" />
    {/* Code lines */}
    <line
      x1="8"
      y1="3.75"
      x2="21"
      y2="3.75"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <line
      x1="8"
      y1="12.25"
      x2="16"
      y2="12.25"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);
