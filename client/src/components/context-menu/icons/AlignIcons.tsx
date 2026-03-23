import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

export const IconAlignTextLeft = (props: SvgProps) => (
  <svg viewBox="1 2 14 12" fill="currentColor" aria-hidden="true" {...props}>
    <rect x="2" y="3" width="12" height="2" rx="1" />
    <rect x="2" y="7" width="8" height="2" rx="1" />
    <rect x="2" y="11" width="10" height="2" rx="1" />
  </svg>
);

export const IconAlignTextCenter = (props: SvgProps) => (
  <svg viewBox="1 2 14 12" fill="currentColor" aria-hidden="true" {...props}>
    <rect x="2" y="3" width="12" height="2" rx="1" />
    <rect x="4" y="7" width="8" height="2" rx="1" />
    <rect x="3" y="11" width="10" height="2" rx="1" />
  </svg>
);

export const IconAlignTextRight = (props: SvgProps) => (
  <svg viewBox="1 2 14 12" fill="currentColor" aria-hidden="true" {...props}>
    <rect x="2" y="3" width="12" height="2" rx="1" />
    <rect x="6" y="7" width="8" height="2" rx="1" />
    <rect x="4" y="11" width="10" height="2" rx="1" />
  </svg>
);

// Vertical alignment icons — Mural SVG paths

export const IconAlignVTop = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 4a1 1 0 0 1 1-1h16a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1Zm2 4a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Zm6.293 3.293a1 1 0 0 1 1.414 0l2.5 2.5a1 1 0 0 1-1.414 1.414L13 14.414V20a1 1 0 1 1-2 0v-5.586l-.793.793a1 1 0 0 1-1.414-1.414l2.5-2.5Z"
    />
  </svg>
);

export const IconAlignVMiddle = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="m12.707 6.707 2-2a1 1 0 0 0-1.414-1.414L13 3.586V2a1 1 0 1 0-2 0v1.586l-.293-.293a1 1 0 0 0-1.414 1.414l2 2a1 1 0 0 0 1.414 0ZM20 11a1 1 0 1 0 0-2H4a1 1 0 1 0 0 2h16Zm-2 4a1 1 0 1 0 0-2H6a1 1 0 1 0 0 2h12Zm-6.707 2.293a1 1 0 0 1 1.414 0l2 2a1 1 0 0 1-1.414 1.414L13 20.414V22a1 1 0 1 1-2 0v-1.586l-.293.293a1 1 0 0 1-1.414-1.414l2-2Z" />
  </svg>
);

export const IconAlignVBottom = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M12.707 12.707a1 1 0 0 1-1.414 0l-2.5-2.5a1 1 0 0 1 1.414-1.414l.793.793V4a1 1 0 1 1 2 0v5.586l.793-.793a1 1 0 1 1 1.414 1.414l-2.5 2.5ZM21 16a1 1 0 0 1-1 1H4a1 1 0 1 1 0-2h16a1 1 0 0 1 1 1Zm-2 4a1 1 0 0 1-1 1H6a1 1 0 1 1 0-2h12a1 1 0 0 1 1 1Z" />
  </svg>
);
