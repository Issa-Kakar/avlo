import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Fill-based trash icon — lid, body with cutout interior, two internal lines */
export const IconTrash = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5.5 1a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v1.5h3.75a.75.75 0 0 1 0 1.5h-.7L12.8 13.5a2 2 0 0 1-2 1.5H5.2a2 2 0 0 1-2-1.5L2.45 4h-.7a.75.75 0 0 1 0-1.5H5.5V1Zm1.5 0v1.5h2V1h-2ZM4 5.5l.6 7.5h6.8l.6-7.5H4ZM6.5 7a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 6.5 7Zm3 0a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 9.5 7Z"
    />
  </svg>
);
