import type { FC, SVGProps } from 'react';
import { IconStrokeWeight1, IconStrokeWeight2, IconStrokeWeight3, IconStrokeWeight4 } from './icons/StrokeWeightIcons';

/** Width + icon pairing. Icons are tier-based — different tables map their own
 * widths to the same shared icon set. */
export interface WeightPreset {
  width: number;
  Icon: FC<SVGProps<SVGSVGElement>>;
}

/** Pen + highlighter. */
export const STROKE_WEIGHTS: readonly WeightPreset[] = [
  { width: 4, Icon: IconStrokeWeight1 },
  { width: 7, Icon: IconStrokeWeight2 },
  { width: 10, Icon: IconStrokeWeight3 },
  { width: 13, Icon: IconStrokeWeight4 },
];

/** Connector tool. */
export const CONNECTOR_WEIGHTS: readonly WeightPreset[] = [
  { width: 2, Icon: IconStrokeWeight1 },
  { width: 4, Icon: IconStrokeWeight2 },
  { width: 6, Icon: IconStrokeWeight3 },
  { width: 8, Icon: IconStrokeWeight4 },
];

/** Shape outline. Same numeric range as `CONNECTOR_WEIGHTS` — shapes and
 *  connectors share a "thin 2D outline" aesthetic, not a marker-thick pen
 *  one. Its own table so shape widths can diverge later without touching
 *  the connector inspector. */
export const SHAPE_WEIGHTS: readonly WeightPreset[] = [
  { width: 2, Icon: IconStrokeWeight1 },
  { width: 4, Icon: IconStrokeWeight2 },
  { width: 6, Icon: IconStrokeWeight3 },
  { width: 8, Icon: IconStrokeWeight4 },
];
