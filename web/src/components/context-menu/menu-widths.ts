import { CONNECTOR_WEIGHTS, STROKE_WEIGHTS } from '@/components/toolbar/weights';

// Pen strokes keep the marker scale (4/7/10/13); shapes + connectors share the
// thin-outline scale (2/4/6/8).
export const STROKE_WIDTHS = STROKE_WEIGHTS.map((w) => w.width);
export const OUTLINE_WIDTHS = CONNECTOR_WEIGHTS.map((w) => w.width);
