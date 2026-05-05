/**
 * RoomDocManager - Central authority for Y.Doc and real-time collaboration
 */

import type { RoomId } from '@avlo/shared';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { IndexeddbPersistence } from 'y-indexeddb';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import { getCodeProps } from '@/core/accessors';
import { codeSystem } from '@/core/code/code-system';
import { ConnectorRouter, setActiveConnectorRouter } from '@/core/connectors/connector-router';
import { bboxEquals, computeBBoxFor } from '@/core/geometry/bbox';
import { hydrateImages } from '@/core/image/image-manager';
import { ObjectSpatialIndex } from '@/core/spatial';
import { textLayoutCache } from '@/core/text/text-system';
import type { BBoxTuple } from '@/core/types/geometry';
import { isUnbindableKind, type ObjectHandle, type ObjectKind } from '@/core/types/objects';
import { evictGeometry } from '@/renderer/geometry-cache';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { clearAllObjectCaches, removeObjectCaches } from '@/renderer/object-cache';
import { invalidateWorldAll, invalidateWorldBBox } from '@/renderer/RenderLoop';
import { getVisibleWorldBounds } from '@/stores/camera-store';
import { getUserId } from '@/stores/device-ui-store';
import { useSelectionStore } from '@/stores/selection-store';
import { attach, detach } from './presence/presence';

// Type alias for Y structures
type YObjects = Y.Map<Y.Map<unknown>>;

// Manager interface - public API
export interface IRoomDocManager {
  readonly objects: YObjects;
  readonly objectsById: ReadonlyMap<string, ObjectHandle>;
  readonly spatialIndex: ObjectSpatialIndex;
  readonly connectorRouter: ConnectorRouter;

  mutate(fn: () => void): void;
  destroy(): void;
  undo(): void;
  redo(): void;
  getUndoManager(): Y.UndoManager | null;

  isConnected(): boolean;
}

// Options for RoomDocManager (currently empty, but preserved for future use)
// biome-ignore lint/suspicious/noEmptyInterface: preserved for future use
export interface RoomDocManagerOptions {}

// Implementation class (exported for registry use)
export class RoomDocManagerImpl implements IRoomDocManager {
  // Core properties
  private readonly roomId: RoomId;
  private readonly ydoc: Y.Doc;
  private readonly userId: string;
  readonly objects: YObjects;

  // Providers
  private indexeddbProvider: IndexeddbPersistence | null = null;
  private websocketProvider: YProvider | null = null;

  // Undo/Redo manager
  private undoManager: Y.UndoManager | null = null;

  // Track if destroyed for cleanup
  private destroyed = false;

  // Connection tracking
  private wsConnected = false;
  private wsRepacked = false;

  // Y.Map-based object storage
  readonly objectsById = new Map<string, ObjectHandle>();
  readonly spatialIndex = new ObjectSpatialIndex();
  readonly connectorRouter = new ConnectorRouter();
  // biome-ignore lint/suspicious/noExplicitAny: upstream-type — Yjs YEvent<T> generic is deliberately loose; deep observers receive heterogeneous events across nested maps
  private objectsObserver: ((events: Y.YEvent<any>[], tx: Y.Transaction) => void) | null = null;

  // Reused observer scratch — cleared at top of each fire. Safe because observer
  // is not reentrant (Y.Doc dispatches at end of transaction; applyObjectChanges
  // does not trigger a new transaction).
  private readonly _touchedIds = new Set<string>();
  private readonly _deletedIds = new Set<string>();
  private readonly _rerouteIds = new Set<string>();
  private readonly _dirtyBBoxes: BBoxTuple[] = [];

  constructor(roomId: RoomId, _options?: RoomDocManagerOptions) {
    this.roomId = roomId;

    this.userId = getUserId();

    this.ydoc = new Y.Doc({ guid: roomId });
    this.objects = this.ydoc.getMap('objects') as YObjects;

    // Wire router globally so module-level getters (getConnectorRoute, getAttachedConnectors)
    // resolve against this room's router. Cleared in destroy().
    setActiveConnectorRouter(this.connectorRouter);

    // Async init: IDB → hydrate → observer → UndoManager → WS
    void this.init();
  }

  private async init(): Promise<void> {
    // 1. IDB sync with 1s timeout
    await this.initializeIndexedDBProvider();
    if (this.destroyed) return;

    // 2. Hydrate from IDB data (first STR bulk load + initial connector routes)
    this.hydrateObjectsFromY();

    // 3. Attach deep observer AFTER hydrate (critical ordering)
    this.setupObjectsObserver();

    // 4. UndoManager
    this.attachUndoManager();

    // 5. WS provider (sync listener handles repack)
    if (!this.destroyed) this.initializeWebSocketProvider();
  }

  /**
   * Attach UndoManager to track local changes
   * CRITICAL: Only call after Y.Doc structures are initialized
   */
  private attachUndoManager(): void {
    if (this.undoManager) {
      console.warn('[RoomDocManager] UndoManager already attached');
      return;
    }

    this.undoManager = new Y.UndoManager([this.objects], {
      trackedOrigins: new Set([this.userId, ySyncPluginKey]),
      captureTimeout: 500,
    });
  }

  mutate(fn: () => void): void {
    if (this.destroyed) return;
    this.ydoc.transact(fn, this.userId);
  }

  undo(): void {
    if (this.destroyed) return;
    if (!this.undoManager) {
      console.warn('[RoomDocManager] UndoManager not initialized');
      return;
    }
    this.undoManager.undo();
  }

  redo(): void {
    if (this.destroyed) return;
    if (!this.undoManager) {
      console.warn('[RoomDocManager] UndoManager not initialized');
      return;
    }
    this.undoManager.redo();
  }

  getUndoManager(): Y.UndoManager | null {
    return this.undoManager;
  }

  // Lifecycle
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // Cleanup providers
    if (this.indexeddbProvider) {
      this.indexeddbProvider.destroy();
      this.indexeddbProvider = null;
    }

    // Detach presence listeners (signals departure while WS still open)
    detach();

    if (this.websocketProvider) {
      this.websocketProvider.disconnect();
      this.websocketProvider.destroy();
      this.websocketProvider = null;
    }

    // Destroy UndoManager
    if (this.undoManager) {
      this.undoManager.destroy();
      this.undoManager = null;
    }

    // Remove objects observer
    if (this.objectsObserver) {
      try {
        this.objects.unobserveDeep(this.objectsObserver);
      } catch {
        // Ignore errors during cleanup
      }
      this.objectsObserver = null;
    }

    // Clean up spatial index
    this.spatialIndex.clear();

    // Clear connector router state + unwire global before object-cache teardown.
    this.connectorRouter.clear();
    setActiveConnectorRouter(null);

    // Clear all object caches (geometry + layout)
    clearAllObjectCaches();

    // Clear object maps
    this.objectsById.clear();

    // Destroy Y.Doc
    this.ydoc.destroy();
  }

  // ============================================================
  // PART 2: Objects Observers (Deep observer on objects Y.Map)
  // ============================================================
  private setupObjectsObserver(): void {
    if (this.objectsObserver) return; // idempotent

    this.objectsObserver = (events, _tx) => {
      const touchedIds = this._touchedIds;
      const deletedIds = this._deletedIds;
      const rerouteIds = this._rerouteIds;
      touchedIds.clear();
      deletedIds.clear();
      rerouteIds.clear();

      for (const ev of events) {
        // Top-level object adds/deletes
        if (ev.target === this.objects && ev instanceof Y.YMapEvent) {
          for (const [key, change] of ev.changes.keys) {
            const id = String(key);
            if (change.action === 'delete') {
              deletedIds.add(id);
              // Both calls safely no-op if id unknown to the router.
              this.connectorRouter.removeConnector(id);
              this.connectorRouter.removeShape(id);
            } else {
              touchedIds.add(id);
              const yObj = this.objects.get(id);
              if (yObj?.get('kind') === 'connector') {
                rerouteIds.add(id);
                this.connectorRouter.registerConnector(id, yObj);
              }
            }
          }
          continue;
        }

        // Nested changes - path[0] is object ID
        const path = ev.path as (string | number)[];
        const id = String(path[0] ?? '');
        if (!id) continue;
        const yObj = this.objects.get(id);
        if (!yObj) continue; // deleted in this tx — event-order independent
        touchedIds.add(id);

        // Direct edits on the object's root Y.Map
        if (path.length === 1 && ev instanceof Y.YMapEvent) {
          const kind = yObj.get('kind') as ObjectKind | undefined;
          if (kind === 'connector') {
            const startChanged = ev.keysChanged.has('start');
            const endChanged = ev.keysChanged.has('end');
            const typeChanged = ev.keysChanged.has('connectorType');
            if (startChanged || endChanged || typeChanged) {
              rerouteIds.add(id);
              if (startChanged || endChanged) this.connectorRouter.updateAnchors(id, yObj);
            }
          } else if (kind === 'shape' && ev.keysChanged.has('shapeType')) {
            // Shape-type swap rewires snap edge geometry. Frame changes are caught by
            // Phase B's bbox-diff propagation — no need to also key-check here.
            const attached = this.connectorRouter.getAttached(id);
            if (attached) for (const cid of attached) rerouteIds.add(cid);
          }
        }

        // Y.XmlFragment change: invalidate text cache (eager re-tokenize for inline styles)
        // Y.Text change (code blocks): sync tokenize + dispatch to Lezer worker
        if (path.length >= 2 && String(path[1] ?? '') === 'content') {
          const content = yObj.get('content');
          const kind = yObj.get('kind') as string | undefined;
          if (kind === 'code' && ev instanceof Y.YTextEvent) {
            const lang = getCodeProps(yObj)?.language ?? 'javascript';
            codeSystem.handleContentChange(id, ev, lang);
          } else if (content instanceof Y.XmlFragment) {
            textLayoutCache.invalidateContent(id, content);
          }
        }
      }

      if (touchedIds.size === 0 && deletedIds.size === 0) return;

      this.applyObjectChanges();
    };

    this.objects.observeDeep(this.objectsObserver);
  }

  private applyObjectChanges(): void {
    const touchedIds = this._touchedIds;
    const deletedIds = this._deletedIds;
    const rerouteIds = this._rerouteIds;
    const dirtyBBoxes = this._dirtyBBoxes;
    dirtyBBoxes.length = 0;

    // === PHASE A: deletions === (router maps already updated in observer)
    for (const id of deletedIds) {
      const handle = this.objectsById.get(id);
      if (!handle) continue;
      this.spatialIndex.remove(id, handle.bbox);
      removeObjectCaches(id, handle.kind);
      dirtyBBoxes.push(handle.bbox);
      this.objectsById.delete(id);
    }

    // Selection deletion bridge
    const sel = useSelectionStore.getState();
    const editingId = sel.textEditingId;
    const selectedSet = sel.selectedIdSet;
    let needsRefresh = false;
    let needsReposition = false;

    if (selectedSet.size > 0) {
      for (const id of deletedIds) {
        if (selectedSet.has(id)) {
          sel.clearSelection();
          break;
        }
      }
    } else if (editingId && deletedIds.has(editingId)) {
      useSelectionStore.getState().endTextEditing();
    }
    const codeEditingId = sel.codeEditingId;
    if (codeEditingId && deletedIds.has(codeEditingId)) {
      useSelectionStore.getState().endCodeEditing();
    }

    // === PHASE B: touched non-connectors + style-only connectors ===
    // Updates non-connector handles BEFORE Phase C reads them via frameOf — Phase C must
    // see the post-Phase-B view of bindable handles. Style-only connectors (color/width/cap)
    // also handled here; rerouting connectors defer to Phase C.
    for (const id of touchedIds) {
      const yObj = this.objects.get(id);
      if (!yObj) continue;
      const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';

      if (kind === 'connector') {
        if (rerouteIds.has(id)) continue; // defer to Phase C
        // Style-only branch: route unchanged, but bbox may shift (caps/width).
        const newBBox = this.connectorRouter.computeBBox(id, yObj);
        const r = this.upsertHandle(id, kind, yObj, newBBox, dirtyBBoxes, selectedSet, editingId);
        if (r.needsRefresh) needsRefresh = true;
        if (r.needsReposition) needsReposition = true;
        continue;
      }

      // Non-connector branch
      const prevBBox = this.objectsById.get(id)?.bbox ?? null;
      const newBBox = computeBBoxFor(id, kind, yObj);
      const r = this.upsertHandle(id, kind, yObj, newBBox, dirtyBBoxes, selectedSet, editingId);
      if (r.needsRefresh) needsRefresh = true;
      if (r.needsReposition) needsReposition = true;

      // Bindable bbox change → propagate to attached connectors. Single rule covers shape
      // frame, text/code/note/bookmark derived-frame changes (text reflow, code lang swap,
      // font swap, scale, bookmark height change).
      if (!isUnbindableKind(kind) && prevBBox && !bboxEquals(prevBBox, newBBox)) {
        const attached = this.connectorRouter.getAttached(id);
        if (attached) {
          for (const cid of attached) {
            if (!deletedIds.has(cid)) rerouteIds.add(cid);
          }
        }
      }
    }

    // === PHASE C: process reroute set ===
    // `rerouteIds` was mutated during Phase B; iterating now sees the finalized set.
    // The `if (!yObj) continue` guard covers ids added via propagation that race with delete.
    for (const id of rerouteIds) {
      const yObj = this.objects.get(id);
      if (!yObj) continue;
      // Pre-seed objectsById with a placeholder so the routing pipeline's getHandle(id)
      // resolves to this connector (newly-added connectors haven't reached objectsById yet).
      // Existing connectors keep their previous bbox during the route call (it's
      // overwritten via upsertHandle below). The router doesn't read this entry's bbox.
      if (!this.objectsById.has(id)) {
        this.objectsById.set(id, { id, kind: 'connector', y: yObj, bbox: [0, 0, 0, 0] });
      }
      const newBBox = this.connectorRouter.rerouteCanonical(id);
      // Connector reroute always invalidates Path2D regardless of bbox — route changed.
      // Subsequent bbox-mismatch eviction inside upsertHandle is harmless (delete on absent key is no-op).
      evictGeometry(id);
      const r = this.upsertHandle(id, 'connector', yObj, newBBox, dirtyBBoxes, selectedSet, editingId);
      if (r.needsRefresh) needsRefresh = true;
      if (r.needsReposition) needsReposition = true;
    }

    if (needsRefresh) useSelectionStore.getState().refreshStyles();
    if (needsReposition) {
      useSelectionStore.setState((s) => ({ boundsVersion: s.boundsVersion + 1 }));
      // Selection handles follow remote moves/undos of the currently selected object
      invalidateOverlay();
    }

    this.flushDirtyBBoxes(dirtyBBoxes);
  }

  /**
   * Insert/update a handle: spatial index insert/update, bbox-changed eviction,
   * dirty-rect bookkeeping, selection-refresh tracking. Returns whether selection
   * state needs refresh / reposition.
   */
  private upsertHandle(
    id: string,
    kind: ObjectKind,
    yObj: Y.Map<unknown>,
    newBBox: BBoxTuple,
    dirtyBBoxes: BBoxTuple[],
    selectedSet: ReadonlySet<string>,
    editingId: string | null,
  ): { needsRefresh: boolean; needsReposition: boolean } {
    const prev = this.objectsById.get(id);
    const oldBBox = prev?.bbox ?? null;

    const handle: ObjectHandle = { id, kind, y: yObj, bbox: newBBox };
    this.objectsById.set(id, handle);

    if (oldBBox) {
      this.spatialIndex.update(id, oldBBox, newBBox, kind);
    } else {
      this.spatialIndex.insert(id, newBBox, kind);
    }

    if (!oldBBox) {
      dirtyBBoxes.push(newBBox);
    } else {
      const bboxChanged = !bboxEquals(oldBBox, newBBox);
      if (bboxChanged) {
        evictGeometry(id);
        dirtyBBoxes.push(oldBBox);
        dirtyBBoxes.push(newBBox);
      } else {
        dirtyBBoxes.push(newBBox);
      }
    }

    let needsRefresh = false;
    let needsReposition = false;
    if (selectedSet.has(id) || id === editingId) {
      needsRefresh = true;
      if (!oldBBox || !bboxEquals(oldBBox, newBBox)) needsReposition = true;
    }
    return { needsRefresh, needsReposition };
  }

  private flushDirtyBBoxes(bboxes: BBoxTuple[]): void {
    if (bboxes.length === 0) return;
    const vp = getVisibleWorldBounds();
    for (const bbox of bboxes) {
      if (bbox[2] >= vp.minX && bbox[0] <= vp.maxX && bbox[3] >= vp.minY && bbox[1] <= vp.maxY) {
        invalidateWorldBBox(bbox);
      }
    }
  }

  // ============================================================
  // PART 3: Rebuild Epoch (Hydrate from Y.Map)
  // ============================================================

  private hydrateObjectsFromY(): void {
    this.objectsById.clear();
    this.spatialIndex.clear();
    this.connectorRouter.clear();
    clearAllObjectCaches();

    const handles: ObjectHandle[] = [];
    const mediaHandles: ObjectHandle[] = [];
    const deferredConnectorIds: string[] = [];

    // Pass 1: build handles for everything except connectors. Connectors only get
    // their anchorIds + shapeToConnectors entries here — bbox + route deferred to pass 2.
    this.objects.forEach((yObj, key) => {
      const id = String(key);
      const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';

      if (kind === 'connector') {
        this.connectorRouter.registerConnector(id, yObj);
        deferredConnectorIds.push(id);
        return;
      }

      const bbox = computeBBoxFor(id, kind, yObj);
      const handle: ObjectHandle = { id, kind, y: yObj, bbox };
      this.objectsById.set(id, handle);
      handles.push(handle);
      if (kind === 'image' || kind === 'bookmark') mediaHandles.push(handle);
    });

    // Pass 2: route + handle for connectors (bindable frames are ready post pass 1).
    for (const id of deferredConnectorIds) {
      const yObj = this.objects.get(id);
      if (!yObj) continue;
      // Inserting into objectsById BEFORE rerouteCanonical so getHandle(id) inside the
      // routing pipeline sees this connector. Bbox is filled post-route.
      this.objectsById.set(id, { id, kind: 'connector', y: yObj, bbox: [0, 0, 0, 0] });
      const bbox = this.connectorRouter.rerouteCanonical(id);
      const handle: ObjectHandle = { id, kind: 'connector', y: yObj, bbox };
      this.objectsById.set(id, handle);
      handles.push(handle);
    }

    if (handles.length > 0) {
      this.spatialIndex.bulkLoad(handles);
    }

    hydrateImages(mediaHandles);
    invalidateWorldAll();
  }

  private async initializeIndexedDBProvider(): Promise<void> {
    try {
      const dbName = `avlo.v1.rooms.${this.roomId}`;
      this.indexeddbProvider = new IndexeddbPersistence(dbName, this.ydoc);
      await Promise.race([this.indexeddbProvider.whenSynced, new Promise<void>((resolve) => setTimeout(resolve, 1000))]).catch(() => {});
    } catch (err) {
      console.error('[RoomDocManager] IDB initialization failed (non-critical):', err);
    }
  }

  private initializeWebSocketProvider(): void {
    try {
      const host = window.location.host;

      this.websocketProvider = new YProvider(host, this.roomId, this.ydoc, {
        connect: true,
        party: 'rooms',
        maxBackoffTime: 10_000,
        resyncInterval: -1,
      });

      // Attach presence module to provider's awareness
      attach(this.websocketProvider, (wsConnected) => {
        this.wsConnected = wsConnected;
        if (!wsConnected) this.wsRepacked = false;
      });

      // Listen for sync status — repack spatial index on first sync per connection
      this.websocketProvider.on('sync', (isSynced: boolean) => {
        if (isSynced && !this.wsRepacked) {
          this.repackSpatialIndex();
          this.wsRepacked = true;
        }
      });
    } catch (err: unknown) {
      console.error('[RoomDocManager] WebSocket initialization failed:', err);
    }
  }

  private repackSpatialIndex(): void {
    this.spatialIndex.clear();
    const handles = Array.from(this.objectsById.values());
    if (handles.length > 0) this.spatialIndex.bulkLoad(handles);
  }

  public isConnected(): boolean {
    return this.wsConnected;
  }
}
