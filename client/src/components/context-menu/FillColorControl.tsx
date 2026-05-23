import { ColorGrid } from './ColorGrid';
import { FILL_PALETTE } from './color-palette';
import { IconColorFill } from './icons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

interface FillColorControlProps {
  /** Current fill color, or null for "no fill". */
  fillColor: string | null;
  /** Multiple distinct fills across the selection. */
  mixed: boolean;
  onSelect: (color: string | null) => void;
}

/**
 * Shape / text fill color — a square-glyph trigger opening the shared 6×4 fill
 * palette with a no-fill swatch.
 */
export function FillColorControl({ fillColor, mixed, onSelect }: FillColorControlProps) {
  const { open, containerRef, toggle, close } = useDropdown();

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-teardrop" onMouseDown={toggle} aria-expanded={open}>
        <IconColorFill fill={fillColor} mixed={mixed} engaged={open} />
      </MenuButton>
      {open && (
        <div className="ctx-submenu ctx-submenu-cp">
          <ColorGrid
            palette={FILL_PALETTE}
            cols={6}
            noFill
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
