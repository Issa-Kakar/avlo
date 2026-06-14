import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Stroke-width trigger — three stacked bars of increasing weight (Mural strokeWeight). */
export const IconWeightBars = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M20.5 2a1 1 0 1 1 0 2h-17a1 1 0 0 1 0-2h17Zm0 5.981a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1h17Zm1 8.981a1 1 0 0 0-1-1h-17a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h17a1 1 0 0 0 1-1v-4Z" />
  </svg>
);

// Stroke-weight tiers — one diagonal stroke drawn at four thicknesses
// (Mural strokeWeight{Thin,Medium,Bold,ExtraHeavy}). Tier glyphs, not pixel
// widths: the same icon set maps onto pen 4/7/10/13 and outline 2/4/6/8.

export const IconWeight1 = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M17.657 4.929a1 1 0 1 1 1.414 1.414L6.343 19.071a1 1 0 1 1-1.414-1.414L17.657 4.929Z" />
  </svg>
);

export const IconWeight2 = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M16.596 4.575a1.5 1.5 0 0 1 2.122 0l.707.707a1.5 1.5 0 0 1 0 2.122L7.404 19.424a1.5 1.5 0 0 1-2.121 0l-.708-.706a1.5 1.5 0 0 1 0-2.122l12.021-12.02Z" />
  </svg>
);

export const IconWeight3 = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M15.536 4.222a2 2 0 0 1 2.828 0l1.414 1.414a2 2 0 0 1 0 2.828L8.464 19.778a2 2 0 0 1-2.828 0l-1.414-1.414a2 2 0 0 1 0-2.829L15.535 4.223Z" />
  </svg>
);

export const IconWeight4 = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M14.121 4.222a3 3 0 0 1 4.243 0l1.414 1.414a3 3 0 0 1 0 4.243l-9.9 9.9a3 3 0 0 1-4.242 0l-1.414-1.415a3 3 0 0 1 0-4.243l9.9-9.9Z" />
  </svg>
);
