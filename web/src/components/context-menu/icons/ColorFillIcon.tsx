import type React from 'react';
import { adaptiveRim, ColorTeardrop } from './ColorTeardrop';

// `fill` is omitted from the base — SVGProps types it `string | undefined`,
// and this glyph's `fill` is the parameterized fill color (string | null).
interface IconColorFillProps extends Omit<React.SVGProps<SVGSVGElement>, 'fill'> {
  /** Current fill color, or null for "no fill". */
  fill: string | null;
  /** Mixed selection — defer to the shared three-swatch mixed glyph. */
  mixed?: boolean;
  /** Picker open — the trigger sits on the dark engaged fill. */
  engaged?: boolean;
}

/**
 * Fill-color trigger glyph (shapes / text / sticky notes). A filled square
 * inside a rim — the slashed `colorFillNone` glyph when there is no fill, and
 * the shared three-swatch mixed drop when the selection is mixed. The ring
 * uses the teardrop's adaptive rim so black fills keep edge definition.
 */
export const IconColorFill = ({ fill, mixed, engaged, ...props }: IconColorFillProps) => {
  if (mixed) return <ColorTeardrop {...props} color={fill ?? '#000'} mixed engaged={engaged} />;
  if (fill === null) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
        <path
          fill="#000"
          d="M21.401 5.401A1.5 1.5 0 1 0 19.28 3.28l-16 16A1.5 1.5 0 1 0 5.4 21.4l1.52-1.52a.533.533 0 0 1 .542-.122c.485.157 1 .24 1.537.24h6a5 5 0 0 0 5-5V9c0-.535-.084-1.052-.24-1.536a.533.533 0 0 1 .12-.542l1.521-1.52ZM15 4c.298 0 .42.352.21.562L4.561 15.21c-.21.21-.562.089-.562-.21V9a5 5 0 0 1 5-5h6Z"
        />
        <path
          fill="#000"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M4 15c0 .298.352.42.562.21L15.21 4.561C15.42 4.352 15.298 4 15 4H9a5 5 0 0 0-5 5v6Zm-.72 4.28A1.5 1.5 0 1 0 5.4 21.4l1.52-1.52a.533.533 0 0 1 .542-.122A4.975 4.975 0 0 0 9 20h6a5 5 0 0 0 5-5V9a5.043 5.043 0 0 0-.24-1.536.533.533 0 0 1 .12-.542l1.521-1.52A1.5 1.5 0 1 0 19.28 3.28l-16 16Z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill={fill}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M17 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3Z"
      />
      <path
        fill={adaptiveRim(fill, engaged)}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Zm0 1h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z"
      />
    </svg>
  );
};
