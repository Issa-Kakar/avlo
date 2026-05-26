import { ColorGrid } from './ColorGrid';
import { FILL_PALETTE } from './color-palette';
import { IconColorBorder } from './icons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

interface BorderColorControlProps {
  /** Current border (stroke) color, or null for "no stroke". */
  color: string | null;
  /** Multiple distinct border colors across the selection. */
  mixed: boolean;
  onSelect: (color: string | null) => void;
}

/**
 * Shape border color — a frame-glyph trigger opening the shared 6×4 fill
 * palette with a no-stroke swatch.
 */
export function BorderColorControl({ color, mixed, onSelect }: BorderColorControlProps) {
  const { open, containerRef, toggle, close } = useDropdown();

  return (
    <div ref={containerRef} className="relative">
      <MenuButton className="ctx-btn-sq ctx-btn-engaged" onMouseDown={toggle} aria-expanded={open}>
        <IconColorBorder color={color} mixed={mixed} />
      </MenuButton>
      {open && (
        <div className="ctx-submenu min-w-0 p-0">
          <ColorGrid
            palette={FILL_PALETTE}
            cols={6}
            noFill
            value={color}
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
