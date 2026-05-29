import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

// Mural `tipStartNone` — a centered bar, symmetric so start + end share the
// same glyph. 24-viewBox `currentColor` fill.
export const IconTipNone = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M5 11h14v2H5v-2Z" />
  </svg>
);

// Mural `tipEndSolidArrow` — solid arrow tip on a bar. The base path points
// to the right (end cap); `direction='left'` mirrors via 180° rotation around
// the viewBox center so the same path serves both endpoints.
export const IconTipArrow = ({ direction = 'right', ...props }: SvgProps & { direction?: 'left' | 'right' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path
      transform={direction === 'left' ? 'rotate(180 12 12)' : undefined}
      d="M20.733 12.468a.544.544 0 0 0 0-.936l-7.671-4.46a.53.53 0 0 0-.793.468v3.113H3v2.694h9.269v3.113c0 .414.44.674.793.468l7.671-4.46Z"
    />
  </svg>
);
