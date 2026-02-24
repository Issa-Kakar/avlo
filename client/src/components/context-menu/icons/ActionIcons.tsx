import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Trash-2 style (lid + body + two vertical lines) */
export const IconTrash = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
    <path d="M2.5 4.5H13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M6 2.5H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path
      d="M3.5 4.5L4.25 12.5C4.3 13.05 4.75 13.5 5.3 13.5H10.7C11.25 13.5 11.7 13.05 11.75 12.5L12.5 4.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M6.5 7V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M9.5 7V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
