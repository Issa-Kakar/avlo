import { memo } from 'react';
import { ColorPicker } from './ColorPicker';
import { ColorSlot } from './ColorSlot';

interface Props {
  /** 1 or 3 colors. Each entry is a hex string. */
  colors: readonly string[];
  activeIndex: number;
  isPickerOpen: boolean;

  /** Called when the user clicks a non-active slot. Receives the new index. */
  onSelectSlot: (index: number) => void;
  /** Called when the user clicks the already-active slot — toggles the picker. */
  onTogglePicker: () => void;
  /** Called from the picker grid / custom-color button. */
  onPickColor: (color: string) => void;
  /** Called when the picker's outside-click handler fires. */
  onClosePicker: () => void;
}

/** Vertical column of 1-3 rounded color slots + an optional picker
 * that floats out to the right of the column when isPickerOpen is true.
 * Behavior: clicking a non-active slot switches selection; clicking the
 * active slot toggles the picker. */
export const ColorSlots = memo(function ColorSlots({
  colors,
  activeIndex,
  isPickerOpen,
  onSelectSlot,
  onTogglePicker,
  onPickColor,
  onClosePicker,
}: Props) {
  const activeColor = colors[activeIndex];
  return (
    <div className="color-slots">
      {colors.map((c, i) => {
        const isActive = i === activeIndex;
        return (
          <ColorSlot
            key={i}
            color={c}
            isActive={isActive}
            isPickerOpen={isPickerOpen}
            ariaLabel={`Color slot ${i + 1}`}
            onClick={isActive ? onTogglePicker : () => onSelectSlot(i)}
          />
        );
      })}
      {isPickerOpen && <ColorPicker currentColor={activeColor} onPick={onPickColor} onClose={onClosePicker} />}
    </div>
  );
});
