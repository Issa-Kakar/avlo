import { memo } from 'react';

interface Props {
  color: string;
  isActive?: boolean;
  ariaLabel?: string;
  onSelect: (color: string) => void;
}

export const ColorSwatch = memo(function ColorSwatch({ color, isActive, ariaLabel, onSelect }: Props) {
  return (
    <button
      className={`inspector-swatch ${isActive ? 'is-active' : ''}`}
      style={{ backgroundColor: color }}
      aria-label={ariaLabel ?? `Color ${color}`}
      onClick={() => onSelect(color)}
    />
  );
});
