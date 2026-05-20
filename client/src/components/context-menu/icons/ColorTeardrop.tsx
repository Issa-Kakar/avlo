import type React from 'react';

interface ColorTeardropProps extends React.SVGProps<SVGSVGElement> {
  /** Teardrop fill — the current stroke/connector color. */
  color: string;
  /** Mixed selection: render the three-swatch drop instead of a solid one. */
  mixed?: boolean;
}

// Dark rim — reads against the white menu when closed; merges into the
// #1b1f22 trigger background when the picker is open, so the drop reads as a
// pure color swatch.
const RIM = '#1b1f22';

// Mixed-indicator swatches — pulled from the toolbar picker palette so the
// "many colors" glyph is built from real app colors rather than a stock trio.
const MIX_TOP = '#FF8A47';
const MIX_LEFT = '#4CAF50';
const MIX_RIGHT = '#2196F3';

/** Color trigger glyph — a teardrop filled with the current color, or a
 *  three-swatch drop when the selection holds multiple colors. */
export const ColorTeardrop = ({ color, mixed, ...props }: ColorTeardropProps) => {
  if (mixed) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
        <path
          fill="#fff"
          d="M12 1a7 7 0 0 0-7 7c0 .25-.109.739-.392 1.303-.282.565-.608.946-.81 1.098a7 7 0 0 0 6.896 12.061c.736-.307 1.876-.307 2.612 0a7 7 0 0 0 6.896-12.061c-.202-.152-.528-.533-.81-1.098C19.108 8.74 19 8.25 19 8a7 7 0 0 0-7-7Z"
        />
        <path fill={MIX_LEFT} d="M3 16a5 5 0 1 1 10 0 5 5 0 0 1-10 0Z" />
        <path fill={MIX_TOP} d="M7 8a5 5 0 1 1 10 0A5 5 0 0 1 7 8Z" />
        <path fill={MIX_RIGHT} d="M11 16a5 5 0 1 1 10 0 5 5 0 0 1-10 0Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill={color}
        fillRule="evenodd"
        clipRule="evenodd"
        d="m7.961 7.994.001-.001c.662-.975 1.406-2.48 1.887-4.136.16-.56.422-1.032.793-1.367.378-.34.845-.517 1.358-.517.514 0 .98.176 1.358.517.37.335.633.807.793 1.367.43 1.478 1.055 2.91 1.92 4.184 1.278 1.887 2.968 4.38 2.968 7.353 0 3.946-3.194 6.634-7.039 6.634-3.845 0-7.04-2.688-7.04-6.634 0-2.787 1.503-5.175 3.001-7.4Z"
      />
      <path
        fill={RIM}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7.132 7.436v-.002l.003-.003c.6-.884 1.3-2.293 1.753-3.85.197-.69.54-1.342 1.084-1.833A2.986 2.986 0 0 1 12 .973c.756 0 1.463.265 2.028.775.544.491.887 1.144 1.084 1.832.405 1.395 1.042 2.802 1.837 3.975-.017-.025.017.025 0 0 1.252 1.846 3.09 4.557 3.09 7.839 0 4.584-3.731 7.634-8.039 7.634s-8.04-3.05-8.04-7.634c0-3.132 1.69-5.758 3.172-7.958Zm7.02-3.579c-.161-.56-.423-1.032-.794-1.367A1.986 1.986 0 0 0 12 1.973c-.514 0-.98.176-1.358.517-.37.335-.633.807-.793 1.367-.48 1.655-1.225 3.161-1.887 4.136v.001c-1.5 2.225-3.001 4.613-3.001 7.4 0 3.946 3.194 6.634 7.039 6.634 3.845 0 7.04-2.688 7.04-6.634 0-2.973-1.69-5.466-2.97-7.353-.864-1.274-1.49-2.706-1.919-4.184Z"
      />
    </svg>
  );
};
