import type React from 'react';

// Crude placeholder geometry — to be redesigned. For now each path is laid out so
// its bbox center sits at (12, 12) inside the 0-24 viewBox.
// Grouped in one file: tight design family, shared stroke style.

const VARIANT_STROKE = {
  stroke: 'currentColor',
  strokeWidth: 2.25,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none',
};

export const IconConnectorLine: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <line x1="4" y1="12" x2="20" y2="12" {...VARIANT_STROKE} />
  </svg>
);

export const IconConnectorArrow: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <line x1="4" y1="12" x2="18" y2="12" {...VARIANT_STROKE} />
    <path d="M15 9L18 12L15 15" {...VARIANT_STROKE} />
  </svg>
);

export const IconConnectorDoubleArrow: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <line x1="6" y1="12" x2="18" y2="12" {...VARIANT_STROKE} />
    <path d="M9 9L6 12L9 15" {...VARIANT_STROKE} />
    <path d="M15 9L18 12L15 15" {...VARIANT_STROKE} />
  </svg>
);

// Elbow w/ end-cap arrow. bbox x[6,18], y[8,16] → center (12, 12).
export const IconConnectorElbow: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <path d="M6 8H13C14.1046 8 15 8.8954 15 10V16" {...VARIANT_STROKE} />
    <path d="M12 13L15 16L18 13" {...VARIANT_STROKE} />
  </svg>
);
