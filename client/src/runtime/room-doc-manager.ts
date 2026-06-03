/**
 * RoomDocManager - Central authority for Y.Doc and real-time collaboration
 */

import { getZ, isZKey, type RoomId, type UserId, type YObjects, type ZKey } from '@avlo/shared';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { IndexeddbPersistence } from 'y-indexeddb';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import { getCodeProps } from '@/core/accessors';
import { codeSystem, terminateCodeWorkers } from '@/core/code/code-system';
import { ConnectorRouter } from '@/core/connectors/connector-router';
import { bboxEquals, computeBBoxFor, computeBBoxForInto } from '@/core/geometry/bbox';
import { ensureImageWorkers, hydrateImages } from '@/core/image/image-manager';
import { ObjectSpatialIndex } from '@/core/spatial';
import { textLayoutCache } from '@/core/text/text-system';
import type { BBoxTuple } from '@/core/types/geometry';
import { createHandle, isUnbindableKind, type ObjectHandle, type ObjectKind } from '@/core/types/objects';
import { ZRankTable } from '@/core/z-order/z-rank-table';
import { evictGeometry } from '@/renderer/geometry-cache';
import { clearAllObjectCaches, removeObjectCaches } from '@/renderer/object-cache';
import { invalidateWorldAll, invalidateWorldBBox } from '@/renderer/RenderLoop';
import { getVisibleBoundsTuple } from '@/stores/camera-store';
import { getUserId } from '@/stores/auth-store';
import { useSelectionStore } from '@/stores/selection-store';
import { dispose } from '@/utils/dispose';
import { bindUndoManagerToHistoryStore } from './history-bridge';
import { attach, detach } from './presence/presence';

/** Viewport-cull then publish a dirty rect. `vp` is a scratch tuple from `getVisibleBoundsTuple()`. */
function invalidateIfVisible(b: BBoxTuple, vp: Readonly<BBoxTuple>): void {
  if (b[2] >= vp[0] && b[0] <= vp[2] && b[3] >= vp[1] && b[1] <= vp[3]) invalidateWorldBBox(b);
}

// Manager interface - public API
export interface IRoomDocManager {
  readonly objects: YObjects;
  readonly objectsById: ReadonlyMap<string, ObjectHandle>;
  readonly spatialIndex: ObjectSpatialIndex;
  readonly connectorRouter: ConnectorRouter;
  readonly zOrder: ZRankTable;

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
  private readonly userId: UserId;
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
  readonly zOrder = new ZRankTable();
  private objectsObserver: ((events: Y.YEvent<Y.AbstractType<unknown>>[], tx: Y.Transaction) => void) | null = null;

  // Reused observer scratch — cleared/overwritten at top of each fire. Safe because the
  // observer is not reentrant (Y.Doc dispatches at end of transaction; applyObjectChanges
  // does not trigger a new transaction).
  private readonly _touchedIds = new Set<string>();
  private readonly _deletedIds = new Set<string>();
  private readonly _bboxChangedIds = new Set<string>();
  // Scratch bbox reused across every upsert in a single fire. `upsertHandle` copies its
  // values into `handle.bbox` (or seeds a fresh tuple on first insert) — the scratch never
  // leaks into `objectsById`.
  private readonly _newBBoxScratch: BBoxTuple = [0, 0, 0, 0];

  constructor(roomId: RoomId, _options?: RoomDocManagerOptions) {
    this.roomId = roomId;

    this.userId = getUserId();

    this.ydoc = new Y.Doc({ guid: roomId });
    this.objects = this.ydoc.getMap('objects') as YObjects;

    // Spawn the image worker pool now (synchronous, parallel with init's IDB/WS) so the first
    // image bitmap is ready ASAP. Idempotent + session-scoped — see ensureImageWorkers().
    ensureImageWorkers();

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

    // Clear z-order rank table
    this.zOrder.clear();

    // Drop UI selection so stale selectedIds don't render against the next room's objects.
    useSelectionStore.getState().clearSelection();

    // Clear all object caches (geometry + layout)
    clearAllObjectCaches();

    // Terminate the lezer worker pool (re-created lazily in the next room). Kept out of
    // clearAllObjectCaches() — that also runs on hydrate, which must NOT kill the pool.
    terminateCodeWorkers();

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
            // Caps bake into the cached Path2D (arrowhead is built geometry, not
            // paint-time chrome) — pre-evict regardless of bbox so a cap toggle
            // whose extent doesn't dominate the route bbox still rebuilds. Phase B's
            // bbox-driven eviction would otherwise leave the old Path2D in place.
            if (ev.keysChanged.has('startCap') || ev.keysChanged.has('endCap')) {
              evictGeometry(id);
            }
          } else if (kind === 'shape' && ev.keysChanged.has('shapeType')) {
            evictGeometry(id); // pre-evict Path2D so renderer doesn't re-check per draw
            router.onBindableChanged(id);
          }

          // z key-edit: mirror Y onto handle.z + rank table synchronously with the fire.
          // A z-only edit has no bbox impact, so Phase B's upsertHandle would no-op on
          // bbox check. Updating here keeps next sort site's view consistent without
          // re-reading y.get('z') in Phase B.
          if (ev.keysChanged.has('z')) {
            const handle = this.objectsById.get(id);
            if (handle) {
              const newZ = yObj.get('z') as ZKey;
              this.zOrder.noteZChanged(handle.z, newZ);
              handle.z = newZ;
            }
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
    const {
      _touchedIds: touched,
      _deletedIds: deleted,
      _bboxChangedIds: changed,
      _newBBoxScratch: scratch,
      connectorRouter: router,
    } = this;
    changed.clear();
    const vp = getVisibleBoundsTuple();

    // === PHASE A: deletions === (router maps already updated in observer)
    for (const id of deleted) {
      const handle = this.objectsById.get(id);
      if (!handle) continue;
      this.spatialIndex.remove(handle); // identity removal; envelope mirrors still describe the live entry
      this.zOrder.releaseSlot(handle.slot, handle.z);
      removeObjectCaches(id, handle.kind);
      invalidateIfVisible(handle.bbox, vp);
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
        if (!router.computeBBox(id, yObj, scratch)) continue;
        if (this.upsertHandle(id, kind, yObj, scratch, vp, false)) changed.add(id);
        continue;
      }

      // Non-connector branch. computeBBoxForInto populates the kind's subsystem
      // cache as a side effect — image meta + text/code/note/bookmark layout.
      computeBBoxForInto(id, kind, yObj, scratch);
      const bboxChanged = this.upsertHandle(id, kind, yObj, scratch, vp, false);

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
      if (!router.rerouteCanonical(id, yObj, scratch)) continue; // routing failed → leave handle as-is (next observer pass corrects)
      const bboxChanged = this.upsertHandle(id, 'connector', yObj, scratch, vp, true); // route changed → always evict
      touched.add(id);
      if (bboxChanged) changed.add(id);
    }

    sel.onObjectsChanged(touched, changed);
  }

  /**
   * Insert/update a handle in place. On first insert, allocates the ObjectHandle once
   * (via `createHandle`) with its own owned `bbox` tuple cloned from `newBBox` and the
   * rbush mirror fields seeded to match. On update, mutates `handle.bbox` + mirrors
   * in place via `spatialIndex.updateHandleBBox` — provably safe because no downstream
   * consumer holds a bbox ref across observer fires (transform/topology/image-manager
   * snapshot at gesture begin; renderer and spatial index destructure on read).
   *
   * Ordering critical when `bboxChanged`: publish prev rect BEFORE calling
   * `updateHandleBBox` (rbush's `remove` reads the current envelope to locate the leaf,
   * and we still want the prev-rect publish to use the old values). `updateHandleBBox`
   * internally encapsulates the remove → mutate → insert dance.
   *
   * Returns `bboxChanged`. Caller drives selection bookkeeping + bindable propagation off
   * the flag.
   */
  private upsertHandle(
    id: string,
    kind: ObjectKind,
    yObj: Y.Map<unknown>,
    newBBox: BBoxTuple,
    vp: Readonly<BBoxTuple>,
    alwaysEvict: boolean,
  ): boolean {
    const handle = this.objectsById.get(id);

    if (!handle) {
      const z = getZ(yObj);
      if (!isZKey(z)) throw new Error(`upsertHandle: object ${id} (kind=${kind}) has no z key`);
      const slot = this.zOrder.acquireSlot();
      const fresh = createHandle(id, kind, yObj, newBBox, z, slot);
      this.zOrder.noteAdd(z);
      this.objectsById.set(id, fresh);
      this.spatialIndex.insert(fresh);
      evictGeometry(id);
      invalidateIfVisible(fresh.bbox, vp);
      return true;
    }

    const bboxChanged = !bboxEquals(handle.bbox, newBBox);

    if (bboxChanged) {
      invalidateIfVisible(handle.bbox, vp); // prev area — handle.bbox still old
      this.spatialIndex.updateHandleBBox(handle, newBBox); // remove(handle) → applyHandleBBox → insert(handle)
    }
    if (bboxChanged || alwaysEvict) evictGeometry(id);
    invalidateIfVisible(handle.bbox, vp); // new area — always (content may have changed visually even when bbox identical)

    return bboxChanged;
  }

  // ============================================================
  // PART 3: Rebuild Epoch (Hydrate from Y.Map)
  // ============================================================

  private hydrateObjectsFromY(): void {
    this.objectsById.clear();
    this.spatialIndex.clear();
    this.connectorRouter.clear();
    this.zOrder.clear();
    clearAllObjectCaches();

    const handles: ObjectHandle[] = [];
    const deferredConnectorIds: string[] = [];

    // Pass 1: build handles for everything except connectors. Connectors only get
    // their anchorIds + shapeToConnectors entries here — bbox + route deferred to pass 2.
    // `computeBBoxFor` populates each kind's subsystem cache (image meta + text/code/
    // note/bookmark layout) so the immediately-following hydrateImages() reads them.
    // Slot acquisition is deferred to zOrder.load() below so slots are densely packed [0..N-1].
    this.objects.forEach((yObj, key) => {
      const id = String(key);
      const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';

      if (kind === 'connector') {
        this.connectorRouter.registerConnector(id, yObj);
        deferredConnectorIds.push(id);
        return;
      }

      const z = getZ(yObj);
      if (!isZKey(z)) throw new Error(`hydrate: object ${id} (kind=${kind}) has no z key`);
      const bbox = computeBBoxFor(id, kind, yObj);
      const handle = createHandle(id, kind, yObj, bbox, z, -1); // slot=-1 sentinel; zOrder.load assigns
      this.objectsById.set(id, handle);
      handles.push(handle);
    });

    // Pass 2: route + handle for connectors (bindable frames are ready post pass 1).
    // Router takes `yObj` directly — no placeholder set. The handle enters
    // `objectsById` exactly once with its real bbox. Hydrate exception to the
    // no-bbox-dummy rule: on routing failure, `bbox` stays `[0,0,0,0]` and the
    // next observer fire (e.g. anchor shape hydrating) corrects it.
    for (const id of deferredConnectorIds) {
      const yObj = this.objects.get(id);
      if (!yObj) continue;
      const z = getZ(yObj);
      if (!isZKey(z)) throw new Error(`hydrate: connector ${id} has no z key`);
      const bbox: BBoxTuple = [0, 0, 0, 0];
      this.connectorRouter.rerouteCanonical(id, yObj, bbox); // mutates bbox tuple in place
      const handle = createHandle(id, 'connector', yObj, bbox, z, -1); // slot=-1 sentinel; zOrder.load assigns
      this.objectsById.set(id, handle);
      handles.push(handle);
    }

    if (handles.length > 0) {
      this.spatialIndex.load(handles);
    }
    this.zOrder.load(this.objectsById.values());

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
    if (handles.length > 0) this.spatialIndex.load(handles);
  }

  public isConnected(): boolean {
    return this.wsConnected;
  }
}
