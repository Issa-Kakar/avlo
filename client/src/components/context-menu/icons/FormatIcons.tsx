import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

export const IconBold = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="#1F2937" aria-hidden="true" {...props}>
    <path d="M4 2.5h4.5a3 3 0 0 1 2.1 5.15A3.25 3.25 0 0 1 9 13.5H4V2.5Zm1.5 4.25h3a1.5 1.5 0 0 0 0-3h-3v3Zm0 1.5v3.75h3.5a1.75 1.75 0 0 0 0-3.5H5.5Z" />
  </svg>
);

export const IconItalic = (props: SvgProps) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path fill="#1F2937" d="M12 2H6v2h2L5 12H3v2h6v-2H7l3-8h2V2Z" />
  </svg>
);
