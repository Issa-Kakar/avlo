import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Sharp-corner rectangle (hollow via evenodd cutout) */
export const IconRectType = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3Zm1.5.5v9h9v-9h-9Z"
    />
  </svg>
);

/** Perfect circle (hollow via evenodd cutout) */
export const IconCircleType = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM3.5 8a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0Z"
    />
  </svg>
);

/** Rotated square / diamond (hollow via evenodd cutout) */
export const IconDiamondType = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      d="M8 1.586 14.414 8 8 14.414 1.586 8 8 1.586ZM3.414 8 8 12.586 12.586 8 8 3.414 3.414 8Z"
    />
  </svg>
);

/** Rounded rectangle (hollow via evenodd cutout, rx=3) */
export const IconRoundedRectType = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      d="M2 6a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V6Zm4-2.5a2.5 2.5 0 0 0-2.5 2.5v4A2.5 2.5 0 0 0 6 12.5h4a2.5 2.5 0 0 0 2.5-2.5V6A2.5 2.5 0 0 0 10 3.5H6Z"
    />
  </svg>
);
