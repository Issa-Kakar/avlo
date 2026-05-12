import { memo } from 'react';
import { CheckIcon } from './CheckIcon';
import { checkmarkColorFor, isDark } from './palette';

interface Props {
  color: string;
  isActive: boolean;
  isPickerOpen: boolean; // only meaningful when isActive — drives aria-expanded
  ariaLabel: string;
  onClick: () => void;
}

/** A single rounded-rect color slot. When active, shows a checkmark whose
 * color flips for contrast and an offset outline in the slot's own color.
 * Dark colors get an inner white border (data-dark) to keep the rect edge
 * readable against the dock background. */
export const ColorSlot = memo(function ColorSlot({ color, isActive, isPickerOpen, ariaLabel, onClick }: Props) {
  const dark = isDark(color);
  return (
    <button
      className={`color-slot ${isActive ? 'is-active' : ''}`}
      data-dark={dark || undefined}
      style={isActive ? ({ ['--slot-tint' as string]: color, backgroundColor: color } as React.CSSProperties) : { backgroundColor: color }}
      aria-label={ariaLabel}
      aria-haspopup={isActive ? 'dialog' : undefined}
      aria-expanded={isActive ? isPickerOpen : undefined}
      onClick={onClick}
    >
      {isActive && <CheckIcon color={checkmarkColorFor(color)} size={16} />}
    </button>
  );
});
