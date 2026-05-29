import { memo, useMemo } from 'react';
import type { WeightPreset } from '../weights';
import { InspectorButton } from './InspectorButton';

interface Props {
  /** Table the row renders against. Caller picks per-tool (STROKE_WEIGHTS / CONNECTOR_WEIGHTS).
   * Pass a module-level constant so the handler memo never invalidates. */
  presets: readonly WeightPreset[];
  /** Current width; an off-preset value leaves every button inactive. */
  value: number;
  onChange: (width: number) => void;
}

/** Presets-driven row of weight buttons. Controlled — the parent owns the width. Returns
 * a fragment so the buttons stay direct flex children of the surrounding container
 * (`.inspector` for the pen inline row, `.weight-picker` for the connector popout). */
export const WeightSelector = memo(function WeightSelector({ presets, value, onChange }: Props) {
  // Bound the per-preset closure to its own width. Deps are stable module-level refs in
  // practice (presets is a const table, onChange a destructured store action), so the
  // table allocates once per mount and lives until unmount.
  const handlers = useMemo<Record<number, () => void>>(() => {
    const out: Record<number, () => void> = {};
    for (const { width } of presets) out[width] = () => onChange(width);
    return out;
  }, [presets, onChange]);
  return (
    <>
      {presets.map(({ width, Icon }) => (
        <InspectorButton key={width} isActive={value === width} ariaLabel={`Stroke width ${width}`} onClick={handlers[width]}>
          <Icon className="insp-icon" />
        </InspectorButton>
      ))}
    </>
  );
});
