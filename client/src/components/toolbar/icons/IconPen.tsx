import type React from 'react';

// 3 separate filled shapes (nib, body, tip) — pre-computed from Mural's Lottie transforms.
export const IconPen: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    {/* Nib (top-right) */}
    <path d="M15.9 2.6C16.7 1.8 17.9 1.8 18.7 2.6L21.4 5.3C22.2 6.1 22.2 7.3 21.4 8.1L20.1 9.4C19.9 9.6 19.6 9.6 19.4 9.4L14.6 4.6C14.4 4.4 14.4 4.1 14.6 3.9L15.9 2.6Z" />
    {/* Body (center diagonal) */}
    <path d="M13.2 6C13 5.8 12.7 5.8 12.5 6L5.2 13.3C4.9 13.6 5 14 5.4 14.1L5.7 14.2L6 14.3C6.2 14.4 6.3 14.5 6.3 14.7L6.4 14.9L6.9 16.6C6.9 16.7 7.1 16.8 7.2 16.9L8.9 17.4L9.1 17.4C9.3 17.5 9.4 17.6 9.5 17.8L9.5 18L9.7 18.7C9.8 19.1 10.3 19.2 10.6 18.9L18 11.5C18.2 11.3 18.2 11 18 10.8L13.2 6Z" />
    {/* Tip (bottom-left) */}
    <path d="M7.5 19C7.7 19.1 7.8 19.2 7.9 19.4L8.1 20.4C8.2 20.6 8.1 20.9 7.8 20.9C7.8 21 7.7 21 7.6 21L2.6 22C2.3 22.1 1.9 21.8 2 21.4L3 16.4C3 16.3 3.1 16.1 3.1 16C3.2 15.8 3.5 15.6 3.7 15.7L4.4 15.9C4.6 16 4.7 16.1 4.7 16.3L5.2 17.9L5.3 18.2C5.3 18.3 5.5 18.4 5.6 18.5L5.9 18.6L7.5 19Z" />
  </svg>
);
