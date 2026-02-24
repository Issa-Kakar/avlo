import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

export const IconAlignTextLeft = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <rect x="2" y="3" width="12" height="2" rx="1" />
    <rect x="2" y="7" width="8" height="2" rx="1" />
    <rect x="2" y="11" width="10" height="2" rx="1" />
  </svg>
);

export const IconAlignTextCenter = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <rect x="2" y="3" width="12" height="2" rx="1" />
    <rect x="4" y="7" width="8" height="2" rx="1" />
    <rect x="3" y="11" width="10" height="2" rx="1" />
  </svg>
);

export const IconAlignTextRight = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <rect x="2" y="3" width="12" height="2" rx="1" />
    <rect x="6" y="7" width="8" height="2" rx="1" />
    <rect x="4" y="11" width="10" height="2" rx="1" />
  </svg>
);
