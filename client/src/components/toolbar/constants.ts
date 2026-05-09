import { IconStrokeWeight1, IconStrokeWeight2, IconStrokeWeight3, IconStrokeWeight4 } from '@/components/icons';
import type { ConnectorVariant, SizePreset } from '@/stores/device-ui-store';

// Stroke weights — index-aligned with WEIGHT_ICONS.
export const SIZE_PRESETS: readonly SizePreset[] = [4, 7, 10, 13] as const;
export const WEIGHT_ICONS = [IconStrokeWeight1, IconStrokeWeight2, IconStrokeWeight3, IconStrokeWeight4] as const;

// Connector variant options surfaced in the connector inspector.
export const CONNECTOR_VARIANTS: readonly { id: ConnectorVariant; label: string }[] = [
  { id: 'straight', label: 'Straight line' },
  { id: 'doubleArrow', label: 'Double arrow' },
  { id: 'elbow', label: 'Elbow arrow' },
] as const;
