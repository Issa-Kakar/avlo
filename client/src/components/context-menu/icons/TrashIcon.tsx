import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Mural-style filled trash icon — body + lid handle + two inner vertical cutouts via evenodd */
export const IconTrash = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M11 2a3 3 0 0 0-3 3v1H5a1 1 0 0 0 0 2h.129c0 .041.001.083.004.125l.75 12A2 2 0 0 0 7.879 22h8.242a2 2 0 0 0 1.996-1.875l.75-12c.003-.042.004-.084.004-.125H19a1 1 0 1 0 0-2h-3V5a3 3 0 0 0-3-3h-2Zm3 4V5a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v1h4Zm-4 4a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Zm5 1a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Z"
    />
  </svg>
);
