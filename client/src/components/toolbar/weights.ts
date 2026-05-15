import { IconStrokeWeight1, IconStrokeWeight2, IconStrokeWeight3, IconStrokeWeight4 } from './icons/StrokeWeightIcons';

// Preset widths exposed by the pen/highlighter button row.
// The store field is `number` — these are the UI presets, not the value domain.
export type StrokeWidthPreset = 4 | 7 | 10 | 13;

export interface StrokeWeightOption {
  width: StrokeWidthPreset;
  Icon: typeof IconStrokeWeight1;
}

export const STROKE_WEIGHTS: readonly StrokeWeightOption[] = [
  { width: 4, Icon: IconStrokeWeight1 },
  { width: 7, Icon: IconStrokeWeight2 },
  { width: 10, Icon: IconStrokeWeight3 },
  { width: 13, Icon: IconStrokeWeight4 },
] as const;
