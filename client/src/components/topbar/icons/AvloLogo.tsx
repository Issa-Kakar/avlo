import type React from 'react';

/**
 * Avlo logo — MuseoModerno variable font, currently loaded from Google
 * Fonts (see `index.html`); self-host before ship to drop the
 * third-party dependency and the FOUT it allows.
 */
export const AvloLogo: React.FC<React.SVGProps<SVGSVGElement>> = ({ height = 34, ...props }) => (
  <svg viewBox="0 4 64 34" height={height} xmlns="http://www.w3.org/2000/svg" aria-label="avlo" {...props}>
    <text x="1" y="29" fontFamily="'MuseoModerno', sans-serif" fontWeight="600" fontSize="30" fill="currentColor">
      avlo
    </text>
  </svg>
);
