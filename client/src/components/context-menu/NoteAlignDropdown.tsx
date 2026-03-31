import { useSelectionStore } from '@/stores/selection-store';
import type { SelectionStore } from '@/stores/selection-store';
import { setSelectedTextAlign, setSelectedTextAlignV } from '@/lib/utils/selection-actions';
import type { TextAlign, TextAlignV } from '@/lib/object-accessors';
import { MenuButton } from './MenuButton';
import { IconChevronDown } from './icons/UtilityIcons';
import { IconAlignTextLeft, IconAlignTextCenter, IconAlignTextRight } from './icons/AlignIcons';
import { IconAlignVTop, IconAlignVMiddle, IconAlignVBottom } from './icons/AlignIcons';
import { useDropdown } from './useDropdown';

const selectTextAlign = (s: SelectionStore) => s.selectedStyles.textAlign;
const selectTextAlignV = (s: SelectionStore) => s.selectedStyles.textAlignV;

const H_ALIGNS: { align: TextAlign; Icon: typeof IconAlignTextLeft }[] = [
  { align: 'left', Icon: IconAlignTextLeft },
  { align: 'center', Icon: IconAlignTextCenter },
  { align: 'right', Icon: IconAlignTextRight },
];

const V_ALIGNS: { align: TextAlignV; Icon: typeof IconAlignVTop }[] = [
  { align: 'top', Icon: IconAlignVTop },
  { align: 'middle', Icon: IconAlignVMiddle },
  { align: 'bottom', Icon: IconAlignVBottom },
];

export function NoteAlignDropdown() {
  const { open, containerRef, toggle, close } = useDropdown();
  const textAlign = useSelectionStore(selectTextAlign);
  const textAlignV = useSelectionStore(selectTextAlignV);
  const currentH = textAlign ?? 'center';
  const currentV = textAlignV ?? 'middle';
  const ActiveIcon = H_ALIGNS.find((a) => a.align === currentH)!.Icon;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-type" onMouseDown={toggle} aria-expanded={open}>
        <ActiveIcon width={16} height={16} />
        <IconChevronDown className="ctx-dd-arrow" />
      </MenuButton>
      {open && (
        <div className="ctx-submenu ctx-submenu-note-align">
          <div className="ctx-align-row">
            {H_ALIGNS.map(({ align, Icon }) => (
              <button
                key={align}
                className={`ctx-align-item${align === currentH ? ' ctx-align-item-active' : ''}`}
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
          <div className="ctx-align-divider" />
          <div className="ctx-align-row">
            {V_ALIGNS.map(({ align, Icon }) => (
              <button
                key={align}
                className={`ctx-align-item${align === currentV ? ' ctx-align-item-active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSelectedTextAlignV(align);
                  close();
                }}
              >
                <Icon width={16} height={16} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
