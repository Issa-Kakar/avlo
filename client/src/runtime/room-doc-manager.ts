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
import { ConnectorRouter } from '@/core/connectors/connector-router';
import { bboxEquals, computeBBoxFor } from '@/core/geometry/bbox';
import { hydrateImages, registerBookmarkMeta, registerImageMeta, unregisterMedia } from '@/core/image/image-manager';
import { ObjectSpatialIndex } from '@/core/spatial';
import { textLayoutCache } from '@/core/text/text-system';
import type { BBoxTuple } from '@/core/types/geometry';
import { isUnbindableKind, type ObjectHandle, type ObjectKind } from '@/core/types/objects';
import { evictGeometry } from '@/renderer/geometry-cache';
import { clearAllObjectCaches, removeObjectCaches } from '@/renderer/object-cache';
import { invalidateWorldAll, invalidateWorldBBox } from '@/renderer/RenderLoop';
import { getVisibleBoundsTuple } from '@/stores/camera-store';
import { getUserId } from '@/stores/device-ui-store';
import { useSelectionStore } from '@/stores/selection-store';
import { dispose } from '@/utils/dispose';
import { bindUndoManagerToHistoryStore } from './history-bridge';
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
  private unbindHistory: (() => void) | null = null;

  // Track if destroyed for cleanup
  private destroyed = false;

  // Connection tracking
  private wsConnected = false;
  private wsRepacked = false;

  // Y.Map-based object storage
  readonly objectsById = new Map<string, ObjectHandle>();
  readonly spatialIndex = new ObjectSpatialIndex();
  readonly connectorRouter = new ConnectorRouter();
  private objectsObserver: ((events: Y.YEvent<Y.AbstractType<unknown>>[], tx: Y.Transaction) => void) | null = null;

  // Reused observer scratch — cleared at top of each fire. Safe because observer
  // is not reentrant (Y.Doc dispatches at end of transaction; applyObjectChanges
  // does not trigger a new transaction).
  private readonly _touchedIds = new Set<string>();
  private readonly _deletedIds = new Set<string>();
  private readonly _bboxChangedIds = new Set<string>();
  private readonly _dirtyBBoxes: BBoxTuple[] = [];

  constructor(roomId: RoomId, _options?: RoomDocManagerOptions) {
    this.roomId = roomId;

    this.userId = getUserId();

    this.ydoc = new Y.Doc({ guid: roomId });
    this.objects = this.ydoc.getMap('objects') as YObjects;

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
    this.unbindHistory = bindUndoManagerToHistoryStore(this.undoManager);
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

    this.indexeddbProvider = dispose(this.indexeddbProvider, (p) => p.destroy());

    // Detach presence listeners (signals departure while WS still open)
    detach();

    this.websocketProvider = dispose(this.websocketProvider, (p) => {
      p.disconnect();
      p.destroy();
    });
    this.unbindHistory = dispose(this.unbindHistory, (fn) => fn());
    this.undoManager = dispose(this.undoManager, (m) => m.destroy());
    this.objectsObserver = dispose(this.objectsObserver, (fn) => this.objects.unobserveDeep(fn));

    // Clean up spatial index
    this.spatialIndex.clear();

    // Clear connector router state before object-cache teardown.
    this.connectorRouter.clear();

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

    this.objectsObserver = (events) => {
      const { _touchedIds: touched, _deletedIds: deleted, connectorRouter: router } = this;
      touched.clear();
      deleted.clear();

      for (const ev of events) {
        // Top-level adds/deletes
        if (ev.target === this.objects && ev instanceof Y.YMapEvent) {
          for (const [key, change] of ev.changes.keys) {
            const id = String(key);
            if (change.action === 'delete') {
              deleted.add(id);
              router.onObjectDeleted(id);
            } else {
              touched.add(id);
              const yObj = this.objects.get(id);
              if (yObj?.get('kind') === 'connector') router.onConnectorAdded(id, yObj);
            }
          }
          continue;
        }

        const path = ev.path as (string | number)[];
        const id = String(path[0] ?? '');
        if (!id) continue;
        const yObj = this.objects.get(id);
        if (!yObj) continue;
        touched.add(id);

        if (path.length === 1 && ev instanceof Y.YMapEvent) {
          const kind = yObj.get('kind') as ObjectKind | undefined;
          if (kind === 'connector') {
            const startEnd = ev.keysChanged.has('start') || ev.keysChanged.has('end');
            if (startEnd || ev.keysChanged.has('connectorType')) {
              router.onConnectorEdited(id, yObj, startEnd);
            }
          } else if (kind === 'shape' && ev.keysChanged.has('shapeType')) {
            router.onBindableChanged(id);
          }
        }

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

      if (touched.size === 0 && deleted.size === 0) return;
      this.applyObjectChanges();
    };

    this.objects.observeDeep(this.objectsObserver);
  }

  private applyObjectChanges(): void {
    const { _touchedIds: touched, _deletedIds: deleted, _bboxChangedIds: changed, _dirtyBBoxes: dirty, connectorRouter: router } = this;
    dirty.length = 0;
    changed.clear();

    // === PHASE A: deletions === (router maps already updated in observer)
    for (const id of deleted) {
      const handle = this.objectsById.get(id);
      if (!handle) continue;
      this.spatialIndex.remove(id, handle.bbox);
      removeObjectCaches(id, handle.kind);
      if (handle.kind === 'image' || handle.kind === 'bookmark') unregisterMedia(id);
      dirty.push(handle.bbox);
      this.objectsById.delete(id);
    }

    const sel = useSelectionStore.getState();
    sel.onObjectsDeleted(deleted);

    // === PHASE B: touched non-connectors + style-only connectors ===
    // Updates non-connector handles BEFORE Phase C reads them via frameOf — Phase C must
    // see the post-Phase-B view of bindable handles. Style-only connectors (color/width/cap)
    // also handled here; rerouting connectors defer to Phase C.
    for (const id of touched) {
      const yObj = this.objects.get(id);
      if (!yObj) continue;
      const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';

      if (kind === 'connector') {
        if (router.isQueuedForReroute(id)) continue; // defer to Phase C
        // Style-only branch: route unchanged, but bbox may shift (caps/width).
        const newBBox: BBoxTuple = [0, 0, 0, 0];
        if (!router.computeBBox(id, yObj, newBBox)) continue;
        const { prevBBox, bboxChanged } = this.upsertHandle(id, kind, yObj, newBBox);
        this.finalizeUpsert(id, prevBBox, newBBox, bboxChanged, false, dirty);
        if (bboxChanged) changed.add(id);
        continue;
      }

      // Non-connector branch
      const newBBox = computeBBoxFor(id, kind, yObj);
      const { prevBBox, bboxChanged } = this.upsertHandle(id, kind, yObj, newBBox);
      this.finalizeUpsert(id, prevBBox, newBBox, bboxChanged, false, dirty);

      // Media meta cache: idempotent re-register on every touch. AssetIds are
      // immutable post-creation and bookmarks are written atomically (offline/failed
      // unfurl → text object, never a partial bookmark), so this is effectively an
      // insert-only call — the per-touch invocation just keeps the wiring simple.
      if (kind === 'image') registerImageMeta(id, yObj);
      else if (kind === 'bookmark') registerBookmarkMeta(id, yObj);

      if (bboxChanged) {
        changed.add(id);
        // Bindable bbox change → propagate to attached connectors. `onBindableChanged`
        // is a free no-op when no attachments exist; firing on first-insert as well as
        // updates lets connectors reroute when their anchor shape arrives late (remote sync).
        if (!isUnbindableKind(kind)) router.onBindableChanged(id);
      }
    }

    // === PHASE C: drain reroute queue (router-owned) ===
    // The router queue may include ids from observer events AND ids queued via Phase B's
    // bindable-propagation (`onBindableChanged`); the `touched.add(id)` below ensures the
    // post-phase refresh fires for the latter (set add is idempotent).
    for (const id of router.drainRerouteQueue()) {
      const yObj = this.objects.get(id);
      if (!yObj) continue;
      const newBBox = router.rerouteCanonical(id, yObj);
      if (!newBBox) continue; // routing failed → leave handle as-is (next observer pass corrects)
      const { prevBBox, bboxChanged } = this.upsertHandle(id, 'connector', yObj, newBBox);
      this.finalizeUpsert(id, prevBBox, newBBox, bboxChanged, true, dirty); // route changed → always evict
      touched.add(id);
      if (bboxChanged) changed.add(id);
    }

    sel.onObjectsChanged(touched, changed);
    this.flushDirtyBBoxes(dirty);
  }

  /** upsert tail: evict geometry on bbox change (or always, for rerouted connectors) and push dirty rects. */
  private finalizeUpsert(
    id: string,
    prev: BBoxTuple | null,
    next: BBoxTuple,
    bboxChanged: boolean,
    alwaysEvict: boolean,
    dirty: BBoxTuple[],
  ): void {
    if (bboxChanged || alwaysEvict) evictGeometry(id);
    if (bboxChanged && prev) dirty.push(prev);
    dirty.push(next);
  }

  /**
   * Insert/update a handle: spatial index + objectsById bookkeeping. Caller decides
   * whether to evict geometry / push dirty rects / track selection — keyed off the
   * returned `bboxChanged` flag.
   */
  private upsertHandle(
    id: string,
    kind: ObjectKind,
    yObj: Y.Map<unknown>,
    newBBox: BBoxTuple,
  ): { prevBBox: BBoxTuple | null; bboxChanged: boolean } {
    const prev = this.objectsById.get(id);
    const oldBBox = prev?.bbox ?? null;
    this.objectsById.set(id, { id, kind, y: yObj, bbox: newBBox });
    if (oldBBox) this.spatialIndex.update(id, oldBBox, newBBox, kind);
    else this.spatialIndex.insert(id, newBBox, kind);
    return { prevBBox: oldBBox, bboxChanged: !oldBBox || !bboxEquals(oldBBox, newBBox) };
  }

  private flushDirtyBBoxes(bboxes: BBoxTuple[]): void {
    if (bboxes.length === 0) return;
    const vp = getVisibleBoundsTuple();
    for (const bbox of bboxes) {
      if (bbox[2] >= vp[0] && bbox[0] <= vp[2] && bbox[3] >= vp[1] && bbox[1] <= vp[3]) {
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
    const deferredConnectorIds: string[] = [];

    // Pass 1: build handles for everything except connectors. Connectors only get
    // their anchorIds + shapeToConnectors entries here — bbox + route deferred to pass 2.
    // Media meta caches (imageMeta, bookmarkAssetIds) are populated inline so that
    // the immediately-following hydrateImages() call reads them.
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
      if (kind === 'image') registerImageMeta(id, yObj);
      else if (kind === 'bookmark') registerBookmarkMeta(id, yObj);
    });

    // Pass 2: route + handle for connectors (bindable frames are ready post pass 1).
    // Router takes `yObj` directly — no placeholder set. The handle enters
    // `objectsById` exactly once with its real bbox.
    for (const id of deferredConnectorIds) {
      const yObj = this.objects.get(id);
      if (!yObj) continue;
      const bbox = this.connectorRouter.rerouteCanonical(id, yObj) ?? ([0, 0, 0, 0] as BBoxTuple);
      const handle: ObjectHandle = { id, kind: 'connector', y: yObj, bbox };
      this.objectsById.set(id, handle);
      handles.push(handle);
    }

    if (handles.length > 0) {
      this.spatialIndex.bulkLoad(handles);
    }

    hydrateImages();
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
