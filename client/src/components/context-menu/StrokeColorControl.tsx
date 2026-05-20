import { CheckIcon } from '@/components/toolbar/color/CheckIcon';
import { checkmarkColorFor, colorsEqual, luminance, PALETTE, PALETTE_COLS } from '@/components/toolbar/color/palette';
import { ColorTeardrop } from './icons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

interface StrokeColorControlProps {
  /** Current stroke/connector color (the first object's, when mixed). */
  color: string;
  /** Multiple distinct colors across the selection. */
  mixed: boolean;
  onSelect: (color: string) => void;
}

// Light swatches blend into the white picker — give them a darker edge for
// contrast. Mirror of the toolbar picker's white edge on near-black swatches.
const NEAR_WHITE = 0.86;

/**
 * Stroke + connector color: a teardrop trigger filled with the current color
 * (a three-swatch drop when mixed), opening a palette grid. Mimics the toolbar
 * color picker on a light surface — no dark background, no custom-hex entry.
 */
export function StrokeColorControl({ color, mixed, onSelect }: StrokeColorControlProps) {
  const { open, containerRef, toggle, close } = useDropdown();

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-teardrop" onMouseDown={toggle} aria-expanded={open}>
        <ColorTeardrop color={color} mixed={mixed} engaged={open} />
      </MenuButton>
      {open && (
        <div className="ctx-submenu ctx-submenu-cp">
          <div className="ctx-cp-grid" style={{ gridTemplateColumns: `repeat(${PALETTE_COLS}, 1fr)` }}>
            {PALETTE.map((c) => {
              const active = !mixed && colorsEqual(c, color);
              return (
                <button
                  key={c}
                  className="ctx-cp-swatch"
                  data-near-white={luminance(c) > NEAR_WHITE || undefined}
                  style={{ background: c }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(c);
                    close();
                  }}
                >
                  {active && <CheckIcon color={checkmarkColorFor(c)} size={13} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
