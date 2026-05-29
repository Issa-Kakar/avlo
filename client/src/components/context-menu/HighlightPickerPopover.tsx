import { HIGHLIGHT_COLORS } from '@/stores/device-ui-store';
import { selectInlineHighlightColor, useSelectionStore } from '@/stores/selection-store';
import { ColorGrid } from './ColorGrid';
import { NO_FILL } from './color-palette';
import { HighlightIcon } from './icons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

interface HighlightPickerPopoverProps {
  onSelect?: (color: string | null) => void;
}

// Map the null "no highlight" sentinel to NO_FILL so ColorGrid renders the
// shared NoFillIcon at slot 0 — same visual + interaction as every other
// no-fill picker in the menu (FillColorControl, BorderColorControl).
const HIGHLIGHT_PALETTE: readonly string[] = HIGHLIGHT_COLORS.map((c) => c ?? NO_FILL);

export function HighlightPickerPopover({ onSelect }: HighlightPickerPopoverProps) {
  const { open, containerRef, toggle, close } = useDropdown();
  const highlightColor = useSelectionStore(selectInlineHighlightColor);

  return (
    <div ref={containerRef} className="relative">
      <MenuButton className="ctx-btn-sq ctx-btn-engaged" onMouseDown={toggle} aria-expanded={open}>
        <HighlightIcon barColor={highlightColor} width={20} height={20} />
      </MenuButton>
      {open && (
        <div className="ctx-submenu min-w-0 p-0">
          <ColorGrid
            palette={HIGHLIGHT_PALETTE}
            cols={4}
            noFill
            value={highlightColor}
            mixed={false}
            onSelect={(c) => {
              onSelect?.(c);
              close();
            }}
          />
        </div>
      )}
    </div>
  );
}
