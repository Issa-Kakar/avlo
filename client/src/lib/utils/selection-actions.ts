import { getActiveRoomDoc, getCurrentSnapshot, getConnectorsForShape } from '@/canvas/room-runtime';
import { getStartAnchor, getEndAnchor } from '@avlo/shared';
import { useSelectionStore } from '@/stores/selection-store';
import {
  useDeviceUIStore,
  type SizePreset,
  type ConnectorSizePreset,
} from '@/stores/device-ui-store';
import * as Y from 'yjs';

// === Helpers ===

function getSelectedHandles() {
  const { selectedIds } = useSelectionStore.getState();
  if (selectedIds.length === 0) return null;
  const { objectsById } = getCurrentSnapshot();
  return { selectedIds, objectsById };
}

// === Color ===

export function setSelectedColor(color: string): void {
  const ctx = getSelectedHandles();
  if (!ctx) return;

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;
    for (const id of ctx.selectedIds) {
      objects.get(id)?.set('color', color);
    }
  });

  useDeviceUIStore.getState().setDrawingColor(color);
  useSelectionStore.getState().refreshStyles();
}

// === Fill Color ===

export function setSelectedFillColor(fillColor: string | null): void {
  const ctx = getSelectedHandles();
  if (!ctx) return;

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;
    for (const id of ctx.selectedIds) {
      const handle = ctx.objectsById.get(id);
      if (handle?.kind !== 'shape') continue;
      const yObj = objects.get(id);
      if (!yObj) continue;
      if (fillColor === null) yObj.delete('fillColor');
      else yObj.set('fillColor', fillColor);
    }
  });

  const ui = useDeviceUIStore.getState();
  if (fillColor === null) {
    ui.setFillEnabled(false);
  } else {
    ui.setFillColor(fillColor);
    ui.setFillEnabled(true);
  }
  useSelectionStore.getState().refreshStyles();
}

// === Width ===

export function setSelectedWidth(width: number): void {
  const ctx = getSelectedHandles();
  if (!ctx) return;

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;
    for (const id of ctx.selectedIds) {
      objects.get(id)?.set('width', width);
    }
  });

  const { selectionKind } = useSelectionStore.getState();
  if (selectionKind === 'connectorsOnly') {
    useDeviceUIStore.getState().setConnectorSize(width as ConnectorSizePreset);
  } else {
    useDeviceUIStore.getState().setDrawingSize(width as SizePreset);
  }
  useSelectionStore.getState().refreshStyles();
}

// === Shape Type ===

export function setSelectedShapeType(shapeType: string): void {
  const ctx = getSelectedHandles();
  if (!ctx) return;

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;
    for (const id of ctx.selectedIds) {
      const handle = ctx.objectsById.get(id);
      if (handle?.kind !== 'shape') continue;
      objects.get(id)?.set('shapeType', shapeType);
    }
  });

  useSelectionStore.getState().refreshStyles();
}

// === Delete ===

export function deleteSelected(): void {
  const { selectedIds } = useSelectionStore.getState();
  if (selectedIds.length === 0) return;

  const snapshot = getCurrentSnapshot();
  const idsToDelete = new Set(selectedIds);

  // Collect connector anchor cleanups: connectorId → { clearStart, clearEnd }
  const anchorCleanups = new Map<string, { clearStart: boolean; clearEnd: boolean }>();

  for (const id of idsToDelete) {
    const handle = snapshot.objectsById.get(id);
    if (!handle || handle.kind === 'connector') continue;

    const connectorIds = getConnectorsForShape(id);
    if (!connectorIds) continue;

    for (const connectorId of connectorIds) {
      if (idsToDelete.has(connectorId)) continue;

      const connectorHandle = snapshot.objectsById.get(connectorId);
      if (!connectorHandle) continue;

      const startAnchor = getStartAnchor(connectorHandle.y);
      const endAnchor = getEndAnchor(connectorHandle.y);
      const existing = anchorCleanups.get(connectorId) ?? { clearStart: false, clearEnd: false };

      if (startAnchor?.id === id) existing.clearStart = true;
      if (endAnchor?.id === id) existing.clearEnd = true;

      if (existing.clearStart || existing.clearEnd) {
        anchorCleanups.set(connectorId, existing);
      }
    }
  }

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = (ydoc.getMap('root') as Y.Map<any>).get('objects') as Y.Map<Y.Map<any>>;

    // Clear dead anchors first
    for (const [connectorId, { clearStart, clearEnd }] of anchorCleanups) {
      const yObj = objects.get(connectorId);
      if (!yObj) continue;
      if (clearStart) yObj.delete('startAnchor');
      if (clearEnd) yObj.delete('endAnchor');
    }

    // Delete objects
    for (const id of idsToDelete) {
      objects.delete(id);
    }
  });

  useSelectionStore.getState().clearSelection();
}
