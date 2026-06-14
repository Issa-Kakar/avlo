import type React from 'react';

// Mural `preview` glyph — eye in corner brackets. Marks "View only" rows in the dashboard's Type column.
export const EyeIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M1 4a2 2 0 0 1 2-2h4a1 1 0 0 1 0 2H3v2a1 1 0 1 1-2 0V4Zm10.999 10.625A2.618 2.618 0 0 0 14.609 12 2.618 2.618 0 0 0 12 9.375 2.618 2.618 0 0 0 9.389 12a2.618 2.618 0 0 0 2.61 2.625Z" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M11.999 5.75c3.847 0 7.187 2.212 8.576 5.417.23.531.23 1.134 0 1.665-1.39 3.205-4.729 5.417-8.576 5.417-3.847 0-7.186-2.212-8.576-5.417a2.093 2.093 0 0 1 0-1.665c1.39-3.205 4.729-5.417 8.576-5.417ZM16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z"
    />
    <path d="M21 22a2 2 0 0 0 2-2v-2a1 1 0 1 0-2 0v2h-4a1 1 0 1 0 0 2h4Zm0-20a2 2 0 0 1 2 2v2a1 1 0 1 1-2 0V4h-4a1 1 0 1 1 0-2h4ZM1 20a2 2 0 0 0 2 2h4a1 1 0 1 0 0-2H3v-2a1 1 0 1 0-2 0v2Z" />
  </svg>
);
