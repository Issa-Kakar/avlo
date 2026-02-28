import type React from 'react';

interface HighlightIconProps extends React.SVGProps<SVGSVGElement> {
  barColor: string | null;
}

export const HighlightIcon = ({ barColor, ...rest }: HighlightIconProps) => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...rest}>
    {/* Marker: scaled 1:1 from reference (30x30 → 20x20, offset to fit above color bar) */}
    <path
      d="M9.1 14.2L17.9 4.7C18.4 4.2 18.4 3.4 17.9 2.9L15.8 0.8C15.3 0.2 14.5 0.2 14 0.7L4.5 9.5M9.1 14.2L4.5 9.5M9.1 14.2C8.8 14.2 7.9 13.8 7.1 13.8C6.4 13.8 5.5 14.5 5.2 14.8M4.5 9.5C4.6 9.9 4.9 10.8 4.9 11.6C4.9 12.3 4.2 13.2 3.9 13.5M5.2 14.8L4.5 14.2L3.9 13.5M5.2 14.8L4.5 15.5L1.9 15.5L3.9 13.5"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    {/* Nib */}
    <path d="M1.9 14.8L3.2 13.5L4.5 14.8L3.8 15.5Z" fill="currentColor" />
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
