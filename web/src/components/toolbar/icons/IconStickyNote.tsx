import type React from 'react';

// Body with folded corner + text-line cutouts (evenodd); fold triangle as separate path.
// Pre-computed from Mural's Lottie transforms (offsets resolved to viewBox coords).
export const IconStickyNote: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path
      fillRule="evenodd"
      d="M6,2 L18,2 C20.21,2 22,3.79 22,6 L22,11.5 C22,12.33 21.33,13 20.5,13 L18,13 C15.24,13 13,15.24 13,18 L13,20.5 C13,21.33 12.33,22 11.5,22 L6,22 C3.79,22 2,20.21 2,18 L2,6 C2,3.79 3.79,2 6,2z M6,7.78 C6,7.09 6.56,6.53 7.25,6.53 L14.75,6.53 C15.44,6.53 16,7.09 16,7.78 C16,8.47 15.44,9.03 14.75,9.03 L7.25,9.03 C6.56,9.03 6,8.47 6,7.78z M7.25,11.18 C6.56,11.18 6,11.74 6,12.43 C6,13.12 6.56,13.68 7.25,13.68 L10.75,13.68 C11.44,13.68 12,13.12 12,12.43 C12,11.74 11.44,11.18 10.75,11.18z"
    />
    <path d="M15,21.55 C15,21.72 15.17,21.83 15.29,21.71 L21.71,15.29 C21.83,15.17 21.72,15 21.55,15 L18,15 C16.34,15 15,16.34 15,18 L15,21.55z" />
  </svg>
);
