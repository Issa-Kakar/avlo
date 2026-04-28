import { IconStrokeWeight1, IconStrokeWeight2, IconStrokeWeight3, IconStrokeWeight4 } from '@/components/icons';
import { type SizePreset, TEXT_COLOR_PALETTE } from '@/stores/device-ui-store';

export const SIZE_PRESETS: readonly SizePreset[] = [4, 7, 10, 13] as const;

export const WEIGHT_ICONS = [IconStrokeWeight1, IconStrokeWeight2, IconStrokeWeight3, IconStrokeWeight4] as const;

export const FIXED_COLORS: readonly string[] = [...TEXT_COLOR_PALETTE.slice(0, 8)].reverse();

export const MORE_COLORS: readonly string[] = [
  '#FFFFFF',
  '#8B5E3C',
  '#06B6D4',
  '#EC4899',
  '#84CC16',
  '#1E3A8A',
  '#14B8A6',
  '#0EA5E9',
  '#A855F7',
  '#F43F5E',
  '#F5E7C6',
  '#374151',
];

export const HEX_REGEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export const isFixedColor = (c: string) => FIXED_COLORS.some((p) => p.toLowerCase() === c?.toLowerCase());
