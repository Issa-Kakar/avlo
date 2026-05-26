import { PALETTE, PALETTE_COLS } from '@/components/toolbar/color/palette';
import { ColorGrid } from './ColorGrid';
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

/**
 * Stroke + connector color: a teardrop trigger filled with the current color
 * (a three-swatch drop when mixed), opening the shared palette grid. Pen and
 * connector colors are never null — no no-fill swatch.
 */
export function StrokeColorControl({ color, mixed, onSelect }: StrokeColorControlProps) {
  const { open, containerRef, toggle, close } = useDropdown();

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-teardrop ctx-btn-engaged" onMouseDown={toggle} aria-expanded={open}>
        <ColorTeardrop color={color} mixed={mixed} engaged={open} />
      </MenuButton>
      {open && (
        <div className="ctx-submenu ctx-submenu-cp">
          <ColorGrid
            palette={PALETTE}
            cols={PALETTE_COLS}
            value={color}
            mixed={mixed}
            onSelect={(c) => {
              if (c !== null) onSelect(c);
              close();
            }}
          />
        </div>
      )}
    </div>
  );
}
