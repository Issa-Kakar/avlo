import type React from 'react';

/**
 * Avlo logo — MuseoModerno variable font, self-hosted as a woff2 subset
 * (wght 400–700, Latin) via @font-face in `index.css`. Not preloaded, so a
 * brief font-display:swap flash on cold load is expected; add a preload in
 * `index.html` if that ever needs to go away.
 */
export const AvloLogo: React.FC<React.SVGProps<SVGSVGElement>> = ({ height = 34, ...props }) => (
  <svg viewBox="0 4 64 34" height={height} xmlns="http://www.w3.org/2000/svg" aria-label="avlo" {...props}>
    <text x="1" y="29" fontFamily="'MuseoModerno', sans-serif" fontWeight="600" fontSize="30" fill="currentColor">
      avlo
    </text>
  </svg>
);
