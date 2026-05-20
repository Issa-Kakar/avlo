import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

export const IconChevronDown = (props: SvgProps) => (
  <svg viewBox="0 0 10 10" fill="none" aria-hidden="true" {...props}>
    <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Mural filled down-chevron (chevronUpFilled, mirrored). viewBox tight to the glyph. */
export const IconChevronDownFilled = (props: SvgProps) => (
  <svg viewBox="6.293 9 11.414 6.707" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M6.293 10.707A1 1 0 0 1 7 9h10a1 1 0 0 1 .707 1.707l-5 5a1 1 0 0 1-1.414 0l-5-5Z" />
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
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M18.842 5.41a1.5 1.5 0 0 1 .479 2.067l-6.632 10.63a2 2 0 0 1-3.176.288L5.061 13.5a1.5 1.5 0 0 1 .1-2.119l.37-.336a1.5 1.5 0 0 1 2.119.1l2.896 3.184a.25.25 0 0 0 .397-.036l5.408-8.669a1.5 1.5 0 0 1 2.067-.478l.424.264Z" />
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
