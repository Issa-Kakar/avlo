import React from 'react';

/**
 * Vertical three-dot kebab menu icon.
 * Dots at y=3, 10, 17 (7px center-to-center, 3px edge gap).
 * r=2.0 for chunky visible dots.
 */
export const KebabIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 20" width="16" height="20" aria-hidden="true" fill="currentColor" {...props}>
    <circle cx="8" cy="3" r="2" />
    <circle cx="8" cy="10" r="2" />
    <circle cx="8" cy="17" r="2" />
  </svg>
);
