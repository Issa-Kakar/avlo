import type React from 'react';
import { MIX_LEFT, MIX_RIGHT, MIX_TOP } from './ColorTeardrop';

// `color` is omitted from the base — SVGProps types it `string | undefined`,
// and this glyph's `color` is the parameterized stroke color (string | null).
interface IconColorBorderProps extends Omit<React.SVGProps<SVGSVGElement>, 'color'> {
  /** Current border (stroke) color, or null for "no stroke". */
  color: string | null;
  /** Mixed selection — render the three-ring mixed glyph. */
  mixed?: boolean;
}

/**
 * Border-color trigger glyph (shapes). A rounded frame — the slashed
 * `colorBorderNone` glyph when there is no stroke, and `colorBorderMixed`
 * (a blob with three hollow rings, recolored to the shared mixed scheme)
 * when the selection holds multiple border colors. The canonical frame fills
 * with the live stroke color; its offset paths keep Mural's built-in #4e4e4e.
 */
export const IconColorBorder = ({ color, mixed, ...props }: IconColorBorderProps) => {
  if (mixed) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
        <path
          fill="#fff"
          d="M12 1a7 7 0 0 0-7 7c0 .25-.109.739-.392 1.303-.282.565-.608.946-.81 1.098a7 7 0 0 0 6.896 12.061c.736-.307 1.876-.307 2.612 0a7 7 0 0 0 6.896-12.061c-.202-.152-.528-.533-.81-1.098C19.108 8.74 19 8.25 19 8a7 7 0 0 0-7-7Z"
        />
        <path
          fill={MIX_LEFT}
          fillRule="evenodd"
          clipRule="evenodd"
          d="M8 13.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM8 11a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z"
        />
        <path
          fill={MIX_TOP}
          fillRule="evenodd"
          clipRule="evenodd"
          d="M12 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM12 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z"
        />
        <path
          fill={MIX_RIGHT}
          fillRule="evenodd"
          clipRule="evenodd"
          d="M16 13.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm0-2.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z"
        />
      </svg>
    );
  }
  if (color === null) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
        <path
          fill="#000"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M21.401 5.647a1.5 1.5 0 1 0-2.121-2.121l-16 16a1.5 1.5 0 1 0 2.12 2.121l1.52-1.52a.533.533 0 0 1 .542-.121c.485.156 1 .24 1.537.24h6a5 5 0 0 0 5-5v-6c0-.536-.084-1.052-.24-1.536a.533.533 0 0 1 .12-.542l1.521-1.52ZM16 12.255a.5.5 0 0 0-.854-.353l-3.49 3.49a.5.5 0 0 0 .353.854H15a1 1 0 0 0 1-1v-2.99Z"
        />
        <path
          fill="#000"
          d="M15 4.246c.287 0 .405.339.202.542L11.89 8.1a.5.5 0 0 1-.353.146H9a1 1 0 0 0-1 1v2.537a.5.5 0 0 1-.146.354l-3.312 3.311c-.203.203-.542.085-.542-.202v-6a5 5 0 0 1 5-5h6Z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill={color}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4 7.5A3.5 3.5 0 0 1 7.5 4h9A3.5 3.5 0 0 1 20 7.5v9a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 16.5v-9Zm5 2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-5Z"
      />
      <path
        fill="#4e4e4e"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3 7.5A4.5 4.5 0 0 1 7.5 3h9A4.5 4.5 0 0 1 21 7.5v9a4.5 4.5 0 0 1-4.5 4.5h-9A4.5 4.5 0 0 1 3 16.5v-9Zm1 0A3.5 3.5 0 0 1 7.5 4h9A3.5 3.5 0 0 1 20 7.5v9a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 16.5v-9Z"
      />
      <path
        fill="#4e4e4e"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 9.5A1.5 1.5 0 0 1 9.5 8h5A1.5 1.5 0 0 1 16 9.5v5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 8 14.5v-5Zm1 0a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-5Z"
      />
    </svg>
  );
};
