import type React from 'react';

interface HighlightIconProps extends React.SVGProps<SVGSVGElement> {
  barColor: string | null;
}

export const HighlightIcon = ({ barColor, ...rest }: HighlightIconProps) => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...rest}>
    {/* Filled cap */}
    <path d="M11.5 1.5L17 4.5L15 7.5L9.5 4.5Z" fill="currentColor" />
    {/* Barrel + chisel outline */}
    <path
      d="M11.5 1.5L17 4.5L12 13L5 14L6.5 10Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    {/* Cap divider */}
    <line x1="9.5" y1="4.5" x2="15" y2="7.5" stroke="currentColor" strokeWidth="1" />
    {/* Color bar */}
    {barColor !== null ? (
      <rect x="3" y="16.5" width="14" height="2.5" rx="1.25" fill={barColor} />
    ) : (
      <>
        <rect x="3" y="16.5" width="14" height="2.5" rx="1.25" fill="#d1d5db" />
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={4.5 + i * 3} y="16.5" width="1.5" height="2.5" fill="#e5e7eb" />
        ))}
      </>
    )}
  </svg>
);
