import type { ConnectorCap, ConnectorType } from '@/core/connectors/types';

interface ConnectorVariantSpec {
  readonly label: string;
  readonly type: ConnectorType;
  readonly startCap: ConnectorCap;
  readonly endCap: ConnectorCap;
}

// Ordered: drives both the iteration order of the button row and the type union.
export const CONNECTOR_VARIANT_IDS = ['line', 'arrow', 'elbow'] as const;
export type ConnectorVariantId = (typeof CONNECTOR_VARIANT_IDS)[number];

// Clicking a variant button writes ALL three fields atomically — there's no
// preserve-caps branch. Cap configurations beyond these three (e.g. double cap,
// start-only cap) are still reachable via the context menu and live in the
// store, but the inspector only exposes these canonical entry points.
export const CONNECTOR_VARIANT_SPECS: Record<ConnectorVariantId, ConnectorVariantSpec> = {
  line: { label: 'Straight line', type: 'straight', startCap: 'none', endCap: 'none' },
  arrow: { label: 'Straight arrow', type: 'straight', startCap: 'none', endCap: 'arrow' },
  elbow: { label: 'Orthogonal arrow', type: 'elbow', startCap: 'none', endCap: 'arrow' },
};

// Inspector active-state derivation (totally onto the three ids — never null):
//   elbow type         → 'elbow'   (caps are decorative here; ignored)
//   straight + no caps → 'line'
//   straight + any cap → 'arrow'   (single-end, start-only, and double all collapse here)
export function deriveConnectorVariant(type: ConnectorType, startCap: ConnectorCap, endCap: ConnectorCap): ConnectorVariantId {
  if (type === 'elbow') return 'elbow';
  if (startCap === 'none' && endCap === 'none') return 'line';
  return 'arrow';
}
