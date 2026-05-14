import { memo, useMemo } from 'react';
import { STROKE_WEIGHTS, type StrokeWidthPreset } from '../weights';
import { InspectorButton } from './InspectorButton';

interface Props {
  /** Current width; an off-preset value leaves all four buttons inactive. */
  value: number;
  onChange: (width: StrokeWidthPreset) => void;
}

/** The 4-button stroke-weight row. Controlled — the parent owns the width field, so the
 * same component drives the pen inspector now and the connector inspector later. Returns
 * a fragment so the buttons stay direct flex children of `.inspector`. */
export const WeightSelector = memo(function WeightSelector({ value, onChange }: Props) {
  // Per-preset handler table. useMemo (not module-level like the old WEIGHT_HANDLERS)
  // because onChange is a prop — callers pass a stable module-level store action.
  const handlers = useMemo<Record<StrokeWidthPreset, () => void>>(
    () => ({ 4: () => onChange(4), 7: () => onChange(7), 10: () => onChange(10), 13: () => onChange(13) }),
    [onChange],
  );
  return (
    <>
      {STROKE_WEIGHTS.map(({ width, Icon }) => (
        <InspectorButton key={width} isActive={value === width} ariaLabel={`Stroke width ${width}`} onClick={handlers[width]}>
          <Icon className="insp-icon" />
        </InspectorButton>
      ))}
    </>
  );
});
