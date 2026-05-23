import { CheckIcon } from '@/components/toolbar/color/CheckIcon';
import { checkmarkColorFor, colorsEqual, luminance } from '@/components/toolbar/color/palette';

interface ColorGridProps {
  /** Swatches, row-major. With `noFill`, index 0 is the NO_FILL sentinel. */
  palette: readonly string[];
  /** Grid column count. */
  cols: number;
  /** Current color, or null (no fill / no stroke). */
  value: string | null;
  /** Multiple distinct values across the selection — suppresses the active check. */
  mixed: boolean;
  /** Render index 0 as a dedicated no-fill swatch emitting `onSelect(null)`. */
  noFill?: boolean;
  onSelect: (color: string | null) => void;
}

// Light swatches blend into the white picker — a darker edge restores contrast
// (mirror of the toolbar picker's white edge on near-black swatches).
const NEAR_WHITE = 0.86;

/**
 * Presentational swatch grid — the shared body of every context-menu color
 * control. The active swatch shows a centered check; `noFill` renders index 0
 * as a slashed no-fill swatch whose click emits `onSelect(null)`.
 */
export function ColorGrid({ palette, cols, value, mixed, noFill, onSelect }: ColorGridProps) {
  return (
    <div className="ctx-cp-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {palette.map((c, i) => {
        if (noFill && i === 0) {
          return (
            <button
              key="no-fill"
              className="ctx-cp-swatch ctx-cp-swatch-nofill"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(null);
              }}
            >
              {value === null && !mixed && <CheckIcon color="#000" size={13} />}
            </button>
          );
        }
        const active = !mixed && value !== null && colorsEqual(c, value);
        return (
          <button
            key={c}
            className="ctx-cp-swatch"
            data-near-white={luminance(c) > NEAR_WHITE || undefined}
            style={{ background: c }}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(c);
            }}
          >
            {active && <CheckIcon color={checkmarkColorFor(c)} size={13} />}
          </button>
        );
      })}
    </div>
  );
}
