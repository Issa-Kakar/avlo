import { CONTEXT_MENU_COLORS } from './color-palette';
import { MenuButton } from './MenuButton';
import { TextColorIcon } from './icons';
import { useDropdown } from './useDropdown';

interface TextColorPopoverProps {
  color: string;
  onSelect?: (color: string) => void;
}

export function TextColorPopover({ color, onSelect }: TextColorPopoverProps) {
  const { open, containerRef, toggle, close } = useDropdown();

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton
        className="ctx-btn-color"
        onMouseDown={toggle}
      >
        <TextColorIcon barColor={color} width={20} height={20} />
      </MenuButton>
      {open && (
        <div className="ctx-submenu" style={{ minWidth: 'auto', padding: 0 }}>
          <div className="ctx-color-grid">
            {CONTEXT_MENU_COLORS.map((c, i) => {
              const isPastel = i >= 9;
              const isSelected = color === c;
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
