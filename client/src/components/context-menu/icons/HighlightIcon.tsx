import type React from 'react';

interface HighlightIconProps extends React.SVGProps<SVGSVGElement> {
  barColor: string | null;
}

export const HighlightIcon = ({ barColor, ...rest }: HighlightIconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...rest}>
    {/* Highlighter body */}
    <path d="M14.5 2.5a2 2 0 0 1 2.8 0l4.2 4.2a2 2 0 0 1 0 2.8L14.3 16.8 7.2 9.7l7.3-7.2Z" />
    {/* Marker tip */}
    <path d="M6.1 10.8l4.1 4.1L7 18H3.5v-3.5l2.6-3.7Z" />
    {/* Color bar */}
    {barColor !== null ? (
      <rect x="2" y="20" width="12" height="2.5" rx="1.25" fill={barColor} />
    ) : (
      <>
        <rect x="2" y="20" width="12" height="2.5" rx="1.25" fill="#d1d5db" />
        {[0, 1, 2].map((i) => (
          <rect key={i} x={3 + i * 3} y="20" width="1.5" height="2.5" fill="#e5e7eb" />
        ))}
      </>
    )}
  </svg>
);
