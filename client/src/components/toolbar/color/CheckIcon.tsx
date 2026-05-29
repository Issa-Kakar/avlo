import { memo } from 'react';

interface Props {
  /** Stroke color — typically computed from background luminance. */
  color: string;
  size?: number;
  /** Stroke width in viewBox (16) units. Default 2.75 reads as a confident,
   * defined check; bump to ~3 for very prominent contexts. */
  strokeWidth?: number;
}

export const CheckIcon = memo(function CheckIcon({ color, size = 14, strokeWidth = 2.75 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3.25 8.25l3.25 3.25 6.25-6.75"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
});
