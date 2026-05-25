import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Mural-style filled lock icon — body + shackle + keyhole via evenodd */
export const IconLock = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2a5 5 0 0 0-5 5v4a3 3 0 0 0-3 3v5a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-5a3 3 0 0 0-3-3V7a5 5 0 0 0-5-5Zm0 2a3 3 0 0 0-3 3v4h6V7a3 3 0 0 0-3-3Zm2 11a2 2 0 0 1-1 1.732V18.5a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1.768A2 2 0 0 1 12 13a2 2 0 0 1 2 2Z"
    />
  </svg>
);
