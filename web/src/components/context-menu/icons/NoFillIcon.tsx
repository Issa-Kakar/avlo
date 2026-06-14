import type React from 'react';

interface NoFillIconProps extends React.SVGProps<SVGSVGElement> {
  /** When true, lays a check + white halo on top so the check stays
   *  readable where it crosses the slash (which remains visible). */
  selected?: boolean;
}

/**
 * No-fill / no-stroke swatch glyph. Paths are taken verbatim from the
 * design source in prompt.md — `colorTransparent` for the base (white
 * bg + grey ring + diagonal slash) and `checkboxCustom` for the selected
 * overlay (black check punched out of a white halo). The base layers
 * are always drawn so the slash stays visible in both states.
 */
export const NoFillIcon = ({ selected, ...rest }: NoFillIconProps) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" {...rest}>
    {/* Background — rounded square */}
    <path d="M0 4a4 4 0 0 1 4-4h16a4 4 0 0 1 4 4v16a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4Z" fill="#fff" />
    {/* Border ring (2-unit thick, even-odd cutout) */}
    <path
      d="M20 2H4a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2ZM4 0a4 4 0 0 0-4 4v16a4 4 0 0 0 4 4h16a4 4 0 0 0 4-4V4a4 4 0 0 0-4-4H4Z"
      fill="#9ca3af"
      fillRule="evenodd"
      clipRule="evenodd"
    />
    {/* Diagonal slash — top-right to bottom-left, rounded caps, inset ~4
        units from each corner so it never touches them. */}
    <path
      d="M19.707 4.293a1 1 0 0 1 0 1.414l-14 14a1 1 0 0 1-1.414-1.414l14-14a1 1 0 0 1 1.414 0Z"
      fill="#6b7280"
      fillRule="evenodd"
      clipRule="evenodd"
    />
    {selected && (
      <>
        {/* White halo around the check — punches a clean break through the
            slash where the check sits, so it doesn't visually clash. */}
        <path
          d="m5.76 11.04.871-.878a2.612 2.612 0 0 1 3.711 0l.237.239 2.661-3.789a2.613 2.613 0 0 1 3.657-.625l1.006.718a2.624 2.624 0 0 1 .62 3.643l-4.878 6.944a3.225 3.225 0 0 1-4.933.42L5.76 14.734a2.625 2.625 0 0 1 0-3.695Zm9.117-3.278a.613.613 0 0 1 .858-.148l1.005.718a.624.624 0 0 1 .147.866l-4.879 6.945a1.225 1.225 0 0 1-1.876.16L7.18 13.327a.625.625 0 0 1 0-.878l.871-.879a.612.612 0 0 1 .871 0l1.92 1.936 4.034-5.744Z"
          fill="#fff"
          fillRule="evenodd"
          clipRule="evenodd"
        />
        {/* The check itself */}
        <path
          d="M16.74 8.332a.624.624 0 0 1 .147.866l-4.879 6.945a1.225 1.225 0 0 1-1.876.16L7.18 13.327a.625.625 0 0 1 0-.878l.871-.879a.612.612 0 0 1 .871 0l1.92 1.936 4.034-5.744a.613.613 0 0 1 .859-.148l1.005.718Z"
          fill="#000"
          fillRule="evenodd"
          clipRule="evenodd"
        />
      </>
    )}
  </svg>
);
