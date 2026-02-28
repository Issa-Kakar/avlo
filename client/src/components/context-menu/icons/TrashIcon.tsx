import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Fill-based trash icon — lid, body with cutout interior, two internal lines */
export const IconTrash = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M6 1.5A.5.5 0 0 1 6.5 1h3a.5.5 0 0 1 .5.5V3h3a.75.75 0 0 1 0 1.5h-.6l-.65 8.11A1.75 1.75 0 0 1 10 14.25H6a1.75 1.75 0 0 1-1.75-1.64L3.6 4.5H3A.75.75 0 0 1 3 3h3V1.5Zm1.5 0V3h1V1.5h-1ZM5.1 4.5l.65 8.05a.25.25 0 0 0 .25.2h4a.25.25 0 0 0 .25-.2l.65-8.05H5.1ZM6.75 6a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-1.5 0v-4A.75.75 0 0 1 6.75 6Zm2.5 0a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-1.5 0v-4A.75.75 0 0 1 9.25 6Z"
    />
  </svg>
);
