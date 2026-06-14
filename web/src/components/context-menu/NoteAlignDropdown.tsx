import type { TextAlign, TextAlignV } from '@/core/accessors';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import { setSelectedTextAlign, setSelectedTextAlignV } from '@/tools/selection/selection-actions';
import {
  IconAlignTextCenter,
  IconAlignTextLeft,
  IconAlignTextRight,
  IconAlignVBottom,
  IconAlignVMiddle,
  IconAlignVTop,
} from './icons/AlignIcons';
import { MenuButton } from './MenuButton';
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
    <div ref={containerRef} className="relative">
      <MenuButton className="ctx-btn-sq ctx-btn-fmt ctx-btn-engaged" onMouseDown={toggle} aria-expanded={open}>
        <ActiveIcon />
      </MenuButton>
      {open && (
        <div className="ctx-submenu left-1/2 -translate-x-1/2 min-w-0 p-1 flex flex-row items-center gap-0.5">
          <div className="flex gap-0.5">
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
                <Icon width={20} height={20} />
              </button>
            ))}
          </div>
          <div className="ctx-divider" />
          <div className="flex gap-0.5">
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
                <Icon width={20} height={20} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
