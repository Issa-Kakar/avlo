import { HIGHLIGHT_COLORS } from '@/stores/device-ui-store';
import { useSelectionStore, selectInlineHighlightColor } from '@/stores/selection-store';
import { MenuButton } from './MenuButton';
import { HighlightIcon } from './icons';
import { useDropdown } from './useDropdown';

interface HighlightPickerPopoverProps {
  onSelect?: (color: string | null) => void;
}

export function HighlightPickerPopover({ onSelect }: HighlightPickerPopoverProps) {
  const { open, containerRef, toggle, close } = useDropdown();
  const highlightColor = useSelectionStore(selectInlineHighlightColor);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton
        className="ctx-btn-color"
        onMouseDown={toggle}
      >
        <HighlightIcon barColor={highlightColor} width={20} height={20} />
      </MenuButton>
      {open && (
        <div className="ctx-submenu ctx-submenu-highlight">
          <div className="ctx-highlight-grid">
            {HIGHLIGHT_COLORS.map((c, i) => {
              const isSelected = highlightColor === c;
              if (c === null) {
                return (
                  <button
                    key="none"
                    className={`ctx-highlight-swatch ctx-highlight-swatch-none${isSelected ? ' selected' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onSelect?.(null);
                      close();
                    }}
                  >
                    <span className="ctx-highlight-slash" />
                  </button>
                );
              }
              return (
                <button
                  key={i}
                  className={`ctx-highlight-swatch${isSelected ? ' selected' : ''}`}
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
