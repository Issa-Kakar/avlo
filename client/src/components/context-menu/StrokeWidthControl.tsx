import { IconCheck, IconWeight1, IconWeight2, IconWeight3, IconWeight4, IconWeightBars } from './icons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

const TIER_ICONS = [IconWeight1, IconWeight2, IconWeight3, IconWeight4];
const TIER_LABELS = ['Thinnest', 'Thin', 'Thick', 'Thickest'];

interface StrokeWidthControlProps {
  /** Four widths, thinnest → thickest. Pen: 4/7/10/13. Shape + connector: 2/4/6/8. */
  widths: readonly number[];
  /** Uniform width, or null when the selection is mixed. */
  value: number | null;
  onSelect: (width: number) => void;
}

/**
 * Stroke / shape-outline / connector width: a bars-icon trigger opening a
 * four-tier menu (Thinnest…Thickest). The active tier row is filled #282e34.
 */
export function StrokeWidthControl({ widths, value, onSelect }: StrokeWidthControlProps) {
  const { open, containerRef, toggle, close } = useDropdown();

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-weight" onMouseDown={toggle} aria-expanded={open}>
        <IconWeightBars />
      </MenuButton>
      {open && (
        <div className="ctx-submenu ctx-submenu-weight">
          {widths.map((w, i) => {
            const Icon = TIER_ICONS[i];
            const active = w === value;
            return (
              <button
                key={w}
                className={`ctx-submenu-item ctx-weight-item${active ? ' ctx-weight-item-active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(w);
                  close();
                }}
              >
                <Icon width={20} height={20} />
                <span>{TIER_LABELS[i]}</span>
                {active && <IconCheck className="ctx-weight-check" width={15} height={15} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
