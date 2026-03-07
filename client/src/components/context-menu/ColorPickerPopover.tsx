import { CONTEXT_MENU_COLORS, NO_FILL } from './color-palette';
import { MenuButton } from './MenuButton';
import { ColorCircle } from './ColorCircle';
import { IconNoFill } from './icons';
import { useDropdown } from './useDropdown';

interface ColorPickerPopoverProps {
  color: string;
  variant?: 'filled' | 'hollow' | 'none';
  secondColor?: string | null;
  mode?: 'stroke' | 'fill';
  selectedColor?: string | null;
  onSelect?: (color: string) => void;
}

export function ColorPickerPopover({
  color,
  variant = 'filled',
  secondColor,
  mode = 'stroke',
  selectedColor,
  onSelect,
}: ColorPickerPopoverProps) {
  const { open, containerRef, toggle, close } = useDropdown();

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-color" onMouseDown={toggle}>
        <ColorCircle color={color} variant={variant} secondColor={secondColor} />
      </MenuButton>
      {open && (
        <div className="ctx-submenu" style={{ minWidth: 'auto', padding: 0 }}>
          <div className="ctx-color-grid">
            {CONTEXT_MENU_COLORS.map((c, i) => {
              const isPastel = i >= 9;
              const isSelected = selectedColor !== undefined ? selectedColor === c : color === c;

              // In fill mode, replace white (index 10) with no-fill icon
              if (mode === 'fill' && i === 10) {
                return (
                  <button
                    key="no-fill"
                    className={`ctx-color-swatch-nofill${selectedColor === null ? ' selected' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onSelect?.(NO_FILL);
                      close();
                    }}
                  >
                    <IconNoFill width={16} height={16} />
                  </button>
                );
              }

              return (
                <button
                  key={c}
                  className={`ctx-color-swatch${isPastel ? ' pastel' : ''}${isSelected ? ' selected' : ''}`}
                  style={{ background: c }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect?.(c);
                    close();
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
