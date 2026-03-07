import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

export const IconBold = (props: SvgProps) => (
  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M5.0 18.5C4.2 18.5 3.7 18.3 3.4 18.0C3.1 17.7 2.9 17.1 2.9 16.4V3.6C2.9 2.9 3.1 2.3 3.4 2.0C3.7 1.7 4.3 1.5 5.0 1.5C7.5 1.5 10.9 1.5 12.4 1.5C14.5 1.5 16.2 3.4 16.2 5.6C16.2 7.3 15.4 8.7 13.7 9.5C15.9 9.9 17.1 12.1 17.1 13.7C17.1 15.7 16.1 18.5 12.9 18.5C11.9 18.5 7.5 18.5 5.0 18.5ZM11.2 11.0H6.3V15.9H11.2C12.2 15.9 13.5 15.0 13.5 13.4C13.5 11.8 12.2 11.0 11.2 11.0ZM6.3 4.1V8.5H10.8C11.5 8.5 12.9 7.8 12.9 6.2C12.9 4.6 11.4 4.1 10.8 4.1H6.3Z" />
  </svg>
);

export const IconItalic = (props: SvgProps) => (
  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M6.5 2.4C6.5 1.9 6.9 1.5 7.4 1.5H16.0C16.4 1.5 16.8 1.9 16.8 2.4C16.8 2.8 16.4 3.2 16.0 3.2H12.9L9.5 16.8H12.6C13.1 16.8 13.5 17.2 13.5 17.6C13.5 18.1 13.1 18.5 12.6 18.5H4.0C3.6 18.5 3.2 18.1 3.2 17.6C3.2 17.2 3.6 16.8 4.0 16.8H7.1L10.5 3.2H7.4C6.9 3.2 6.5 2.8 6.5 2.4Z"
    />
  </svg>
);
