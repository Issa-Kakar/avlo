import { useSelectionStore } from '@/stores/selection-store';
import type { SelectionStore } from '@/stores/selection-store';
import { setSelectedTextAlign } from '@/lib/utils/selection-actions';
import type { TextAlign } from '@avlo/shared';
import { MenuButton } from './MenuButton';
import { IconChevronDown } from './icons/UtilityIcons';
import { IconAlignTextLeft, IconAlignTextCenter, IconAlignTextRight } from './icons/AlignIcons';
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
      <MenuButton className="ctx-btn-type" onMouseDown={toggle} aria-expanded={open}>
        <ActiveIcon width={16} height={16} />
        <IconChevronDown className="ctx-dd-arrow" />
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
              <Icon width={16} height={16} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
