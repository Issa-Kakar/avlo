import { memo } from 'react';
import { CheckIcon } from './CheckIcon';
import { checkmarkColorFor, isDark } from './palette';

interface Props {
  color: string;
  ariaLabel: string;
  onClick: () => void;
  /** Multi-choice "this is the chosen one" — renders the checkmark + active ring.
   * Omit in single-color contexts (the connector field) — nothing to disambiguate. */
  selected?: boolean;
  /** Set only when this button opens the picker: drives aria-haspopup + aria-expanded.
   * Omit for buttons that don't open a picker (a slot column's non-active slots). */
  expanded?: boolean;
}

/** The shared swatch-button primitive: a rounded color swatch. `selected` and `expanded`
 * are decoupled — a single-color trigger (the connector field) is `expanded` without
 * being `selected`, so it gets the picker aria but no checkmark. Dark colors get an inner
 * white border (data-dark) to keep the rect edge readable against the dock background. */
export const ColorButton = memo(function ColorButton({ color, ariaLabel, onClick, selected, expanded }: Props) {
  const dark = isDark(color);
  return (
    <button
      className={`color-button ${selected ? 'is-active' : ''}`}
      data-dark={dark || undefined}
      style={colorButtonStyle(color, !!selected)}
      aria-label={ariaLabel}
      aria-haspopup={expanded === undefined ? undefined : 'dialog'}
      aria-expanded={expanded}
      onClick={onClick}
    >
      {selected && <CheckIcon color={checkmarkColorFor(color)} size={16} />}
    </button>
  );
});

// CSS custom property — typed via cast because React.CSSProperties doesn't
// list app-specific custom properties. Centralized so the cast lives in one
// place rather than at every call site; exported because ColorPicker's
// swatches reuse it to get the same `--slot-tint` active ring.
export function colorButtonStyle(color: string, selected: boolean): React.CSSProperties {
  if (!selected) return { backgroundColor: color };
  return { '--slot-tint': color, backgroundColor: color } as React.CSSProperties;
}
