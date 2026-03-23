import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Sharp-corner rectangle (hollow via evenodd cutout) */
export const IconRectType = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      d="M1 2a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2Zm1.5.5v11h11v-11h-11Z"
    />
  </svg>
);

/** Perfect circle (hollow via evenodd cutout) */
export const IconCircleType = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM2.5 8a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0Z"
    />
  </svg>
);

/** Rotated square / diamond (hollow via evenodd cutout) */
export const IconDiamondType = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      d="M8 1 15 8 8 15 1 8ZM3 8l5 5 5-5-5-5Z"
    />
  </svg>
);

/** Rounded rectangle (hollow via evenodd cutout) */
export const IconRoundedRectType = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      d="M1 5a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5Zm4-2.5A2.5 2.5 0 0 0 2.5 5v6A2.5 2.5 0 0 0 5 13.5h6a2.5 2.5 0 0 0 2.5-2.5V5A2.5 2.5 0 0 0 11 2.5H5Z"
    />
  </svg>
);

/** Sticky note with fold corner — Mural stickySquareFold */
export const IconStickySquareFold = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M6 2h12a4 4 0 0 1 4 4v5.5a1.5 1.5 0 0 1-1.5 1.5H18a5 5 0 0 0-5 5v2.5a1.5 1.5 0 0 1-1.5 1.5H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4Z" />
    <path d="M15 21.552c0 .168.174.274.293.155l6.414-6.414c.119-.119.013-.293-.155-.293H18a3 3 0 0 0-3 3v3.552Z" />
  </svg>
);
