import type { TextAlign } from '@/core/accessors';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import { setSelectedTextAlign } from '@/tools/selection/selection-actions';
import { IconAlignTextCenter, IconAlignTextLeft, IconAlignTextRight } from './icons/AlignIcons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

const selectTextAlign = (s: SelectionStore) => s.selectedStyles.textAlign;

const ALIGNS: { align: TextAlign; Icon: typeof IconAlignTextLeft }[] = [
  { align: 'left', Icon: IconAlignTextLeft },
  { align: 'center', Icon: IconAlignTextCenter },
  { align: 'right', Icon: IconAlignTextRight },
];

export function AlignDropdown() {
  const { open, containerRef, toggle, close } = useDropdown();
  const textAlign = useSelectionStore(selectTextAlign);
  const current = textAlign ?? 'left';
  const ActiveIcon = ALIGNS.find((a) => a.align === current)!.Icon;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-sq ctx-btn-fmt" onMouseDown={toggle} aria-expanded={open}>
        <ActiveIcon />
      </MenuButton>
      {open && (
        <div className="ctx-submenu ctx-submenu-align">
          {ALIGNS.map(({ align, Icon }) => (
            <button
              key={align}
              className={`ctx-align-item${align === current ? ' ctx-align-item-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setSelectedTextAlign(align);
                close();
              }}
            >
              <Icon width={20} height={20} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
