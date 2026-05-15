import type React from 'react';

// Zoom-control + help icons consumed by `components/ZoomControls.tsx`.
// Toolbar icons live in `components/toolbar/icons/` — don't add toolbar icons here.

// Mural's filled chunky plus.
export const IconZoomPlus: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M9.875 13.625a.5.5 0 0 1 .5.5v3.625c0 .69.56 1.25 1.25 1.25h.75c.69 0 1.25-.56 1.25-1.25v-3.625a.5.5 0 0 1 .5-.5h3.625c.69 0 1.25-.56 1.25-1.25v-.75c0-.69-.56-1.25-1.25-1.25h-3.625a.5.5 0 0 1-.5-.5V6.25c0-.69-.56-1.25-1.25-1.25h-.75c-.69 0-1.25.56-1.25 1.25v3.625a.5.5 0 0 1-.5.5H6.25c-.69 0-1.25.56-1.25 1.25v.75c0 .69.56 1.25 1.25 1.25h3.625Z" />
  </svg>
);

// Mural's filled minus bar.
export const IconZoomMinus: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M5 11.25a1.5 1.5 0 0 1 1.5-1.5h11a1.5 1.5 0 0 1 1.5 1.5v1.5a1.5 1.5 0 0 1-1.5 1.5h-11a1.5 1.5 0 0 1-1.5-1.5v-1.5Z" />
  </svg>
);

// 4 corner arrows + eye center.
export const IconZoomToFit: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M21.71 2.295A.997.997 0 0 1 22 3v4a1 1 0 1 1-2 0V5.414l-1.293 1.293a1 1 0 1 1-1.414-1.414L18.586 4H17a1 1 0 1 1 0-2h4a1 1 0 0 1 .705.29l.004.005ZM7 20a1 1 0 1 1 0 2H2.99A.996.996 0 0 1 2 21v-4a1 1 0 1 1 2 0v1.586l1.293-1.293a1 1 0 0 1 1.414 1.414L5.414 20H7Zm15-3a1 1 0 1 0-2 0v1.586l-1.293-1.293a1 1 0 0 0-1.414 1.414L18.586 20H17a1 1 0 1 0 0 2h4a.997.997 0 0 0 1-1v-4ZM3 8a1 1 0 0 1-1-1V3a.997.997 0 0 1 .29-.705l.005-.004A.99.99 0 0 1 3 2h4a1 1 0 1 1 0 2H5.414l1.293 1.293a1 1 0 0 1-1.414 1.414L4 5.414V7a1 1 0 0 1-1 1Zm7.412 4a1.588 1.588 0 1 1 3.176 0 1.588 1.588 0 0 1-3.176 0Z" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M18.66 11.15c-1.124-2.452-3.705-4.124-6.661-4.124-2.957 0-5.537 1.672-6.66 4.124a2.04 2.04 0 0 0 0 1.699c1.123 2.452 3.704 4.125 6.66 4.125s5.537-1.673 6.66-4.125a2.04 2.04 0 0 0 0-1.699ZM12 8.912a3.088 3.088 0 1 0 0 6.177 3.088 3.088 0 0 0 0-6.177Z"
    />
  </svg>
);

// Circle with question mark cutout.
export const IconHelp: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 1C7.417 1 1 3.75 1 12s5.5 11 11 11 11-2.75 11-11S16.583 1 12 1Zm.693 13.25c0 .68-.58 1.08-1.08 1.08-.32 0-.58-.12-.78-.32-.54-.52-.74-1.14-.74-1.7 0-1.314 1.055-1.987 2.065-2.63.927-.59 1.815-1.156 1.815-2.17 0-.98-.74-1.54-2.02-1.54-1.12 0-1.88.56-1.88 1.68 0 .6-.5 1.1-1.1 1.1-.6 0-1.1-.5-1.1-1.1 0-2.28 1.52-3.64 4.08-3.64 2.64 0 4.18 1.26 4.18 3.5 0 2-1.473 2.85-2.59 3.495-.682.393-1.23.71-1.23 1.165 0 .16.06.28.2.48.12.18.18.38.18.6Zm-1.14 2.02c.84 0 1.3.44 1.3 1.34 0 .88-.46 1.3-1.3 1.3-.84 0-1.32-.42-1.32-1.3 0-.9.48-1.34 1.32-1.34Z"
    />
  </svg>
);

// Mouse with scroll arrows.
export const IconMouseSettings: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M15.922 1.465a.738.738 0 0 1 .158-.24.748.748 0 0 1 .825-.167l2.506 1.046a.75.75 0 0 1-.578 1.384l-.835-.348L21 10.446l.349-.835a.75.75 0 0 1 1.384.578l-1.046 2.506a.747.747 0 0 1-.985.4L18.2 12.053a.75.75 0 1 1 .578-1.384l.835.348L16.61 3.71l-.348.835a.75.75 0 0 1-1.384-.578l1.044-2.502Z" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M1.313 11.59a5.391 5.391 0 0 1 1.415-5.763 8.472 8.472 0 0 1 6.287-2.24 5.391 5.391 0 0 1 4.74 3.57l2.681 7.524a5.391 5.391 0 0 1-1.415 5.764 8.472 8.472 0 0 1-6.287 2.24 5.391 5.391 0 0 1-4.74-3.571L1.312 11.59Zm5.475-4.31a1.5 1.5 0 0 1 1.916.91l.634 1.777a1.5 1.5 0 0 1-2.826 1.007l-.634-1.778a1.5 1.5 0 0 1 .91-1.916Z"
    />
  </svg>
);
