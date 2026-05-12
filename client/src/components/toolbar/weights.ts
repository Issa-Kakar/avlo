import { IconStrokeWeight1, IconStrokeWeight2, IconStrokeWeight3, IconStrokeWeight4 } from '@/components/icons';
import type { StrokeWidth } from '@/stores/device-ui-store';

// Stroke weights — index-aligned with WEIGHT_ICONS.
export const SIZE_PRESETS: readonly StrokeWidth[] = [4, 7, 10, 13] as const;
export const WEIGHT_ICONS = [IconStrokeWeight1, IconStrokeWeight2, IconStrokeWeight3, IconStrokeWeight4] as const;
