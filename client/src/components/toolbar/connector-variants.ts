import type { ConnectorCap, ConnectorType } from '@/core/connectors/types';

interface ConnectorVariantSpec {
  readonly label: string;
  readonly type: ConnectorType;
  readonly startCap: ConnectorCap;
  readonly endCap: ConnectorCap;
}

// Ordered: drives both the iteration order of the button row and the type union.
export const CONNECTOR_VARIANT_IDS = ['line', 'arrow', 'doubleArrow', 'elbow'] as const;
export type ConnectorVariantId = (typeof CONNECTOR_VARIANT_IDS)[number];

export const CONNECTOR_VARIANT_SPECS: Record<ConnectorVariantId, ConnectorVariantSpec> = {
  line: { label: 'Straight line', type: 'straight', startCap: 'none', endCap: 'none' },
  arrow: { label: 'Arrow', type: 'straight', startCap: 'none', endCap: 'arrow' },
  doubleArrow: { label: 'Double arrow', type: 'straight', startCap: 'arrow', endCap: 'arrow' },
  elbow: { label: 'Elbow arrow', type: 'elbow', startCap: 'none', endCap: 'arrow' },
};

// Elbow swallows all elbow cap configurations by design (click preserves caps; only type flips).
// Straight is matched by exact cap pair against the spec table.
export function deriveConnectorVariant(type: ConnectorType, startCap: ConnectorCap, endCap: ConnectorCap): ConnectorVariantId | null {
  if (type === 'elbow') return 'elbow';
  for (const id of CONNECTOR_VARIANT_IDS) {
    const v = CONNECTOR_VARIANT_SPECS[id];
    if (v.type === type && v.startCap === startCap && v.endCap === endCap) return id;
  }
  return null;
}
