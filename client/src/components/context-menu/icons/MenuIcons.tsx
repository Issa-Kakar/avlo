import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

export const IconChevronDown = (props: SvgProps) => (
  <svg viewBox="0 0 10 10" fill="none" aria-hidden="true" {...props}>
    <path
      d="M2 3.5L5 6.5L8 3.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const IconMinus = (props: SvgProps) => (
  <svg viewBox="0 0 12 12" fill="none" aria-hidden="true" {...props}>
    <path d="M2.5 6H9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const IconPlus = (props: SvgProps) => (
  <svg viewBox="0 0 12 12" fill="none" aria-hidden="true" {...props}>
    <path d="M6 2.5V9.5M2.5 6H9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const IconMoreDots = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <circle cx="8" cy="4" r="1.5" />
    <circle cx="8" cy="8" r="1.5" />
    <circle cx="8" cy="12" r="1.5" />
  </svg>
);
