import { memo } from 'react';
import { ColorButton } from './ColorButton';
import { ColorPicker } from './ColorPicker';
import { usePickerDismiss } from './use-picker-dismiss';

interface Props {
  color: string;
  isPickerOpen: boolean;
  onTogglePicker: () => void;
  onPickColor: (color: string) => void;
  onClosePicker: () => void;
}

/** The connector's single-color field — sibling of ColorSlots, also built on
 * ColorButton. One trigger button (no `selected` → no checkmark; nothing to
 * disambiguate with one color) + the picker as a sibling when isPickerOpen. The
 * wrapper contains both so usePickerDismiss's containment check covers them. */
export const ColorField = memo(function ColorField({ color, isPickerOpen, onTogglePicker, onPickColor, onClosePicker }: Props) {
  const rootRef = usePickerDismiss(isPickerOpen, onClosePicker);
  return (
    <div className="color-field" ref={rootRef}>
      <ColorButton color={color} ariaLabel="Connector color" expanded={isPickerOpen} onClick={onTogglePicker} />
      {isPickerOpen && <ColorPicker currentColor={color} onPickColor={onPickColor} />}
    </div>
  );
});
