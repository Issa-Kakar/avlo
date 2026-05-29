import type React from 'react';

// White filled rounded rect with sun + mountain as BLACK cutouts (evenodd).
// Resolved from Mural's mask transforms: translate(12,12)→translate(-2,-2) = translate(10,10)
// Sun: circle at (8,8) radius 2 | Mountain: landscape from y≈10.4 to y=20 | Background: (2,2)→(22,22)
export const IconImage: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path
      fillRule="evenodd"
      d="M2 6a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V6Zm6 4a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3.7 6.71l2.29-2.3a1.5 1.5 0 0 1 2.12 0L10 15.71l4.59-4.59a1.5 1.5 0 0 1 2.12 0l2.29 2.3c.19.18.3.44.3.7V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-.59c0-.26.11-.52.3-.7Z"
    />
  </svg>
);
