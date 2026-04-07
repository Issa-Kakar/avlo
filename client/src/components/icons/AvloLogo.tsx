import React from 'react';

/**
 * Avlo logo — Righteous (single weight) with opacity 0.85 to soften visual weight.
 * ViewBox symmetric around x-height center y≈21 for flexbox alignment.
 */
export const AvloLogo: React.FC<React.SVGProps<SVGSVGElement>> = ({ height = 34, ...props }) => (
  <svg viewBox="0 4 58 34" height={height} xmlns="http://www.w3.org/2000/svg" aria-label="avlo" {...props}>
    <text x="1" y="30" fontFamily="'Righteous', sans-serif" fontSize="29" fill="currentColor" opacity="0.85">
      avlo
    </text>
  </svg>
);
