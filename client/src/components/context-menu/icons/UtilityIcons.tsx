import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

export const IconChevronDown = (props: SvgProps) => (
  <svg viewBox="0 0 10 10" fill="none" aria-hidden="true" {...props}>
    <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
    <circle cx="8" cy="4" r="1.8" />
    <circle cx="8" cy="8" r="1.8" />
    <circle cx="8" cy="12" r="1.8" />
  </svg>
);

export const IconCheck = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M12.207 4.793a1 1 0 0 1 0 1.414l-5 5a1 1 0 0 1-1.414 0l-2.5-2.5a1 1 0 1 1 1.414-1.414L6.5 9.086l4.293-4.293a1 1 0 0 1 1.414 0Z" />
  </svg>
);

export const IconStepUp = (props: SvgProps) => (
  <svg viewBox="0 0 10 6" fill="none" aria-hidden="true" {...props}>
    <path d="M1 5L5 1L9 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconStepDown = (props: SvgProps) => (
  <svg viewBox="0 0 10 6" fill="none" aria-hidden="true" {...props}>
    <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconNoFill = (props: SvgProps) => (
  <svg viewBox="0 0 18 18" fill="none" aria-hidden="true" {...props}>
    <circle cx="9" cy="9" r="7" stroke="#9CA3AF" strokeWidth="1.8" />
    <line x1="4" y1="14" x2="14" y2="4" stroke="#9CA3AF" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
