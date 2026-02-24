import type React from 'react';

interface TextColorIconProps extends React.SVGProps<SVGSVGElement> {
  barColor: string;
}

export const TextColorIcon = ({ barColor, ...rest }: TextColorIconProps) => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...rest}>
    <text
      x="10"
      y="13.5"
      textAnchor="middle"
      fontFamily="Inter, system-ui, sans-serif"
      fontSize="14"
      fontWeight="600"
      fill="currentColor"
    >
      A
    </text>
    <rect x="3" y="16.5" width="14" height="2.5" rx="1.25" fill={barColor} />
  </svg>
);
