import type { ConnectorCap, ConnectorType } from '@/core/connectors/types';
import type { ConnectorVariantId } from '@/stores/device-ui-store';

export type { ConnectorVariantId };

export const CONNECTOR_VARIANT_BUTTONS: readonly { id: ConnectorVariantId; label: string }[] = [
  { id: 'line', label: 'Straight line' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'doubleArrow', label: 'Double arrow' },
  { id: 'elbow', label: 'Elbow arrow' },
] as const;

/**
 * Active toolbar variant for the current connector state, or null if no
 * button matches (e.g. straight with start=arrow, end=none).
 *
 * Elbow swallows all elbow cap configurations by design — clicking the elbow
 * button preserves caps; only the type flips. Straight maps strictly by caps.
 */
export function deriveConnectorVariant(type: ConnectorType, startCap: ConnectorCap, endCap: ConnectorCap): ConnectorVariantId | null {
  if (type === 'elbow') return 'elbow';
  if (startCap === 'arrow' && endCap === 'arrow') return 'doubleArrow';
  if (startCap === 'none' && endCap === 'arrow') return 'arrow';
  if (startCap === 'none' && endCap === 'none') return 'line';
  return null;
}
