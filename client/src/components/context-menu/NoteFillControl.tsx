import { NOTE_COLOR_PALETTE } from '@/stores/device-ui-store';
import { ColorGrid } from './ColorGrid';
import { IconColorFill } from './icons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

// Sticky-note fill palette — the device-ui-store note palette is the single
// source of truth; the picker shows just the fills (6 cols × 2 rows).
const NOTE_FILLS: readonly string[] = NOTE_COLOR_PALETTE.map((c) => c.fill);

interface NoteFillControlProps {
  /** Current note fill color (notes always carry a fill). */
  fillColor: string | null;
  /** Multiple distinct fills across the selection. */
  mixed: boolean;
  onSelect: (color: string | null) => void;
}

/**
 * Sticky-note fill color — a square-glyph trigger opening the sticky palette.
 * Notes always have a fill, so there is no no-fill swatch.
 */
export function NoteFillControl({ fillColor, mixed, onSelect }: NoteFillControlProps) {
  const { open, containerRef, toggle, close } = useDropdown();

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-teardrop" onMouseDown={toggle} aria-expanded={open}>
        <IconColorFill fill={fillColor ?? '#FFD95E'} mixed={mixed} engaged={open} />
      </MenuButton>
      {open && (
        <div className="ctx-submenu ctx-submenu-cp">
          <ColorGrid
            palette={NOTE_FILLS}
            cols={6}
            value={fillColor}
            mixed={mixed}
            onSelect={(c) => {
              onSelect(c);
              close();
            }}
          />
        </div>
      )}
    </div>
  );
}
