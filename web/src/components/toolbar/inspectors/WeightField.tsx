import { memo } from 'react';
import { usePickerDismiss } from '../color/use-picker-dismiss';
import type { WeightPreset } from '../weights';
import { InspectorButton } from './InspectorButton';
import { WeightSelector } from './WeightSelector';

interface Props {
  presets: readonly WeightPreset[];
  /** Current width. Off-preset → the trigger shows the nearest tier's icon; every
   * popout button stays inactive (WeightSelector tests strict equality). */
  value: number;
  isPickerOpen: boolean;
  onTogglePicker: () => void;
  onChangeWidth: (width: number) => void;
  onClosePicker: () => void;
}

/** Closest-by-width preset. Order-independent — doesn't rely on table sort order. */
function nearestPreset(presets: readonly WeightPreset[], value: number): WeightPreset {
  let best = presets[0];
  let bestDiff = Math.abs(best.width - value);
  for (let i = 1; i < presets.length; i++) {
    const diff = Math.abs(presets[i].width - value);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = presets[i];
    }
  }
  return best;
}

/** Single stroke-width field — sibling of ColorField. One trigger button (blue
 * ONLY while the popout is open) and an absolutely-positioned popout with the
 * full presets row. The wrapper contains both so usePickerDismiss covers them. */
export const WeightField = memo(function WeightField({
  presets,
  value,
  isPickerOpen,
  onTogglePicker,
  onChangeWidth,
  onClosePicker,
}: Props) {
  const rootRef = usePickerDismiss(isPickerOpen, onClosePicker);
  const TriggerIcon = nearestPreset(presets, value).Icon;
  return (
    <div className="weight-field" ref={rootRef}>
      <InspectorButton isActive={isPickerOpen} ariaLabel="Stroke width" onClick={onTogglePicker}>
        <TriggerIcon className="insp-icon" />
      </InspectorButton>
      {isPickerOpen && (
        <div className="weight-picker" role="dialog" aria-label="Pick stroke width">
          <WeightSelector presets={presets} value={value} onChange={onChangeWidth} />
        </div>
      )}
    </div>
  );
});
