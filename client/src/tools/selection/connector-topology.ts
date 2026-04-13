/**
 * Connector Topology Builder
 *
 * Computes the topology used by transform operations: which connectors need
 * rerouting vs plain translate, per-endpoint override specs, and pre-allocated
 * mutable caches for per-frame updates.
 *
 * Pure function, free of store / controller dependencies — so both the selection
 * store and the transform controller can import it without cycles.
 */

import type { BBoxTuple, FrameTuple } from '@/core/types/geometry';
import { getHandle, getConnectorsForShape } from '@/runtime/room-runtime';
import { getPoints, getStart, getEnd, getStartAnchor, getEndAnchor } from '@/core/accessors';
import { isBindableHandle } from '@/core/types/objects';
import { frameOf } from '@/core/geometry/frame-of';
import type { ConnectorTopology, ConnectorTopologyEntry, EndpointSpec } from './types';

/**
 * Compute connector topology at transform begin.
 * Pure function: determines which connectors need rerouting vs translate,
 * computes per-endpoint specs, and returns ConnectorTopology.
 *
 * Strategy:
 *   Translate: both endpoints move → translate; else → reroute
 *   Scale: always → reroute
 *
 * EndpointSpec per endpoint:
 *   Anchored + shape selected → shapeId (string)
 *   Free + connector selected → true
 *   Otherwise → null (canonical)
 */
export function computeConnectorTopology(transformKind: 'translate' | 'scale', selectedIds: string[]): ConnectorTopology | null {
  const selectedSet = new Set(selectedIds);

  const entries: ConnectorTopologyEntry[] = [];
  const translateIdSet = new Set<string>();
  const originalFrames = new Map<string, FrameTuple>();

  const visited = new Set<string>();

  const processConnector = (connId: string, isSelected: boolean) => {
    if (visited.has(connId)) return;
    visited.add(connId);

    const connHandle = getHandle(connId);
    if (!connHandle || connHandle.kind !== 'connector') return;

    const startAnchor = getStartAnchor(connHandle.y);
    const endAnchor = getEndAnchor(connHandle.y);

    // Determine if each endpoint moves
    const startMoves = isSelected ? !startAnchor || selectedSet.has(startAnchor.id) : !!startAnchor && selectedSet.has(startAnchor.id);
    const endMoves = isSelected ? !endAnchor || selectedSet.has(endAnchor.id) : !!endAnchor && selectedSet.has(endAnchor.id);

    if (!startMoves && !endMoves) return;

    const points = getPoints(connHandle.y);
    const originalPoints: [number, number][] =
      points.length > 0
        ? (points as [number, number][])
        : [(getStart(connHandle.y) ?? [0, 0]) as [number, number], (getEnd(connHandle.y) ?? [0, 0]) as [number, number]];
    const originalBbox = [...connHandle.bbox] as BBoxTuple;

    // Determine strategy
    if (transformKind === 'translate' && startMoves && endMoves) {
      entries.push({
        connectorId: connId,
        strategy: 'translate',
        originalPoints,
        originalBbox,
        translatedPoints: originalPoints.map((p) => [...p] as [number, number]),
        startSpec: null,
        endSpec: null,
      });
      translateIdSet.add(connId);
    } else {
      const startSpec: EndpointSpec =
        startAnchor && selectedSet.has(startAnchor.id) ? startAnchor.id : !startAnchor && isSelected ? true : null;
      const endSpec: EndpointSpec = endAnchor && selectedSet.has(endAnchor.id) ? endAnchor.id : !endAnchor && isSelected ? true : null;

      entries.push({
        connectorId: connId,
        strategy: 'reroute',
        originalPoints,
        originalBbox,
        translatedPoints: [],
        startSpec,
        endSpec,
      });
    }
  };

  // Pass 1: Selected connectors
  for (const id of selectedIds) {
    const handle = getHandle(id);
    if (handle?.kind === 'connector') {
      processConnector(id, true);
    }
  }

  // Pass 2: Non-selected connectors anchored to selected bindable objects
  for (const id of selectedIds) {
    const handle = getHandle(id);
    if (!isBindableHandle(handle)) continue;
    const connectors = getConnectorsForShape(id);
    if (!connectors) continue;
    for (const connId of connectors) {
      processConnector(connId, selectedSet.has(connId));
    }
  }

  if (entries.length === 0) return null;

  // Collect original frames for all selected bindable objects (for frame overrides)
  for (const id of selectedIds) {
    const handle = getHandle(id);
    if (!isBindableHandle(handle)) continue;
    const frame = frameOf(handle);
    if (frame) originalFrames.set(id, frame);
  }

  // Pre-allocate mutable caches
  const reroutes = new Map<string, [number, number][] | null>();
  const prevBboxes = new Map<string, BBoxTuple>();
  for (const entry of entries) {
    if (entry.strategy === 'reroute') {
      reroutes.set(entry.connectorId, null);
      prevBboxes.set(entry.connectorId, [...entry.originalBbox] as BBoxTuple);
    }
  }

  return {
    entries,
    translateIdSet,
    originalFrames,
    reroutes,
    prevBboxes,
  };
}
