import { memo } from 'react';
import { SLOT_INDICES, type SlotColors, type SlotIndex } from '@/stores/device-ui-store';
import { ColorButton } from './ColorButton';
import { ColorPicker } from './ColorPicker';
import { usePickerDismiss } from './use-picker-dismiss';

interface Props {
  slots: SlotColors;
  activeSlot: SlotIndex;
  isPickerOpen: boolean;
  onSelectSlot: (slot: SlotIndex) => void;
  onTogglePicker: () => void;
  onPickColor: (color: string) => void;
  onClosePicker: () => void;
}

/** The pen/highlighter 3-slot color column — definitionally 3-slot, iterates
 * SLOT_INDICES directly. Renders the picker as a sibling when isPickerOpen; the
 * wrapper contains both the slots and the picker so usePickerDismiss's containment
 * check covers them. Clicking a non-active slot switches selection; clicking the
 * active slot toggles the picker. */
export const ColorSlots = memo(function ColorSlots({
  slots,
  activeSlot,
  isPickerOpen,
  onSelectSlot,
  onTogglePicker,
  onPickColor,
  onClosePicker,
}: Props) {
  const rootRef = usePickerDismiss(isPickerOpen, onClosePicker);
  return (
    <div className="color-slots" ref={rootRef}>
      {SLOT_INDICES.map((i) => {
        const isActive = i === activeSlot;
        return (
          <ColorButton
            key={i}
            color={slots[i]}
            ariaLabel={`Color slot ${i + 1}`}
            selected={isActive}
            expanded={isActive ? isPickerOpen : undefined}
            onClick={isActive ? onTogglePicker : () => onSelectSlot(i)}
          />
        );
      })}
      {isPickerOpen && <ColorPicker currentColor={slots[activeSlot]} onPickColor={onPickColor} />}
    </div>
  );
});
