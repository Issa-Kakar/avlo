import { CheckIcon } from '@/components/toolbar/color/CheckIcon';
import { checkmarkColorFor, colorsEqual, luminance, PALETTE, PALETTE_COLS } from '@/components/toolbar/color/palette';
import { TextColorIcon } from './icons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

interface TextColorPopoverProps {
  color: string;
  onSelect?: (color: string) => void;
}

// Light swatches blend into the white picker — give them a darker edge for
// contrast. Mirror of the toolbar picker's white edge on near-black swatches.
const NEAR_WHITE = 0.86;

export function TextColorPopover({ color, onSelect }: TextColorPopoverProps) {
  const { open, containerRef, toggle, close } = useDropdown();

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-color" onMouseDown={toggle}>
        <TextColorIcon barColor={color} width={20} height={20} />
      </MenuButton>
      {open && (
        <div className="ctx-submenu ctx-submenu-cp">
          <div className="ctx-cp-grid" style={{ gridTemplateColumns: `repeat(${PALETTE_COLS}, 1fr)` }}>
            {PALETTE.map((c) => {
              const active = colorsEqual(c, color);
              return (
                <button
                  key={c}
                  className="ctx-cp-swatch"
                  data-near-white={luminance(c) > NEAR_WHITE || undefined}
                  style={{ background: c }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect?.(c);
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
