/**
 * Connector creation actions.
 *
 * The single place a connector `Y.Map` is built and inserted. Extracted from
 * `ConnectorTool.commitConnector` so both the Connector tool and Select-tool
 * connector flows mint connectors through one schema-correct path.
 *
 *  - `insertConnector(p, z)` — builds + inserts the Y.Map. MUST run inside an
 *    open `transact()`. Used by the combined duplicate+connector transaction.
 *  - `createConnector(p)` — opens its own `transact()` around `insertConnector`.
 *
 * `start`/`end` are already-resolved `ConnectorEndpoint`s — the caller owns snap
 * resolution (`anchorRecordFromSnap`) or hand-builds the anchor literal.
 *
 * @module core/connectors/connector-actions
 */

import { generateZAtTop, type ZKey } from '@avlo/shared';
import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { ConnectorCap, ConnectorEndpoint, ConnectorType } from '@/core/types/objects';
import { getObjects, getZOrder, transact } from '@/runtime/room-runtime';
import { getUserId } from '@/stores/auth-store';

/** Fully-resolved inputs for a new connector. Caller resolves snap → endpoint. */
export interface CreateConnectorParams {
  start: ConnectorEndpoint;
  end: ConnectorEndpoint;
  startCap: ConnectorCap;
  endCap: ConnectorCap;
  connectorType: ConnectorType;
  color: string;
  width: number;
}

/**
 * Build the connector `Y.Map` and register it under `objects`. Returns the new
 * id. **MUST run inside an open `transact()`** — the deep observer wires up the
 * route cache + handle + dirty rect on transaction end.
 */
export function insertConnector(p: CreateConnectorParams, z: ZKey): string {
  const id = ulid();
  const m = new Y.Map<unknown>();

  m.set('id', id);
  m.set('kind', 'connector');
  m.set('start', p.start);
  m.set('end', p.end);
  m.set('startCap', p.startCap);
  m.set('endCap', p.endCap);
  m.set('connectorType', p.connectorType);
  // Connectors are always opacity 1 — not stored.
  m.set('color', p.color);
  m.set('width', p.width);
  m.set('ownerId', getUserId());
  m.set('createdAt', Date.now());
  m.set('z', z);

  getObjects().set(id, m);
  return id;
}

/** Create a connector in its own transaction (newest on top). Returns the new id. */
export function createConnector(p: CreateConnectorParams): string {
  return transact(() => insertConnector(p, generateZAtTop(getZOrder().maxZ()))) as string;
}
