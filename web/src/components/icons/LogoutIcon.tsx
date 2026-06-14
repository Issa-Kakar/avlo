import type React from 'react';

// Mural `leave` glyph — door panel + exiting arrow. Used by the profile menu's Log out row.
export const LogoutIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M18.173 3.109A.996.996 0 0 0 17.719 3h-9a1 1 0 0 0-1 1v4a1 1 0 0 1-2 0V4a3 3 0 0 1 3-3h9a3 3 0 0 1 3 3v14.931a2 2 0 0 1-1.212 1.838l-3 1.286a2 2 0 0 1-2.788-1.838V6.319a2 2 0 0 1 1.213-1.838l3-1.286c.08-.035.16-.063.241-.086Z" />
    <path d="m1.22 11.375 1.719-2.149c.59-.738 1.78-.32 1.78.625V11h5a1 1 0 1 1 0 2h-5v1.148c0 .946-1.19 1.363-1.78.625l-1.72-2.15a1 1 0 0 1 0-1.249ZM5.72 16a1 1 0 1 1 2 0v4a1 1 0 1 1-2 0v-4Z" />
  </svg>
);
