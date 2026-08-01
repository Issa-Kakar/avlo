/**
 * RoomDocManager - Central authority for Y.Doc and real-time collaboration
 */

import { SYNC_HOST_PROD } from '@avlo/api-client';
import { getZ, isZKey, Permission, type RoomId, SYNC_WS_PREFIX, type UserId, type YObjects, type ZKey } from '@avlo/shared';
import { IndexeddbPersistence } from 'y-indexeddb';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import { getContent, getFontFamily, getFontSize, getLanguage, getLocked } from '@/core/accessors';
import { codeSystem, terminateCodeWorkers } from '@/core/code/code-system';
import { ConnectorRouter } from '@/core/connectors/connector-router';
import { bboxEquals, computeBBoxFor, computeBBoxForInto } from '@/core/geometry/bbox';
import { copyBbox } from '@/core/geometry/bounds';
import { ensureImageWorkers, hydrateImages } from '@/core/image/image-manager';
import { attachLocks, detachLocks } from '@/core/locks/lock-protocol';
import {
  bindLockTable,
  getLockOwners,
  lockSlotAcquired,
  lockSlotReleased,
  markLockVeilDirty,
  resetLockTable,
  setLockedFlag,
} from '@/core/locks/lock-table';
import {
  acquireSlot,
  getBBoxColumn,
  registerHandle,
  releaseSlot,
  resetSlotTable,
  slotHighWater,
  writeSlotBBox,
} from '@/core/slots/slot-table';
import { spatialTree } from '@/core/spatial/spatial-tree';
import { textLayoutCache } from '@/core/text/text-system';
import type { BBoxTuple } from '@/core/types/geometry';
import { createHandle, isUnbindableKind, type ObjectHandle, type ObjectKind } from '@/core/types/objects';
import { ZRankTable } from '@/core/z-order/z-rank-table';
import { queryClient } from '@/query/client';
import { ROOMS_QUERY_KEY, type RoomsQueryData } from '@/query/rooms';
import { evictGeometry } from '@/renderer/geometry-cache';
import { notifyLockVeil } from '@/renderer/lock-veil/lock-veil';
import { clearAllObjectCaches, removeObjectCaches } from '@/renderer/object-cache';
import { invalidateWorldAll, invalidateWorldBBox, invalidateWorldSlot } from '@/renderer/RenderLoop';
import { router } from '@/router';
import { getUserId } from '@/stores/auth-store';
import { getVisibleBoundsTuple } from '@/stores/camera-store';
import { bindUndoManagerToHistoryStore } from '@/stores/history-store';
import { removeRoom, setRoomOwnerFact, setRoomPermissionFact } from '@/stores/room-list-store';
import { resetRoomSession, setRoomAccess, setRoomIsOwner, setRoomMode, setRoomPermission, setRoomTitle } from '@/stores/room-session-store';
import { useSelectionStore } from '@/stores/selection-store';
import { dispose } from '@/utils/dispose';
import { ROOM_DOC_DB_PREFIX } from '@/utils/room-local-data';
import { attach, detach } from './presence/presence';

/** Viewport-cull then publish a dirty rect. `vp` is a scratch tuple from `getVisibleBoundsTuple()`. */
function invalidateIfVisible(b: BBoxTuple, vp: Readonly<BBoxTuple>): void {
  if (b[2] >= vp[0] && b[0] <= vp[2] && b[3] >= vp[1] && b[1] <= vp[3]) invalidateWorldBBox(b);
}

/** StackItem.meta key → Set<string> of top-level object ids the item's transaction(s) wrote. */
const UNDO_TOUCHED_IDS = Symbol('avlo:undo-touched-ids');

// Manager interface - public API
export interface IRoomDocManager {
  readonly objects: YObjects;
  readonly objectsById: ReadonlyMap<string, ObjectHandle>;
  readonly connectorRouter: ConnectorRouter;
  readonly zOrder: ZRankTable;

  mutate(fn: () => void): void;
  destroy(): void;
  undo(): void;
  redo(): void;
  getUndoManager(): Y.UndoManager | null;

  isConnected(): boolean;
}

// Instantiated by room-runtime; consumers type against IRoomDocManager.
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
  private unbindUndoMeta: (() => void) | null = null;

  // Track if destroyed for cleanup
  private destroyed = false;

  // Connection tracking
  private wsConnected = false;
  private wsRepacked = false;

  // Y.Map-based object storage
  readonly objectsById = new Map<string, ObjectHandle>();
  readonly connectorRouter = new ConnectorRouter();
  readonly zOrder = new ZRankTable();
  private objectsObserver: ((events: Y.YEvent<Y.AbstractType<unknown>>[], tx: Y.Transaction) => void) | null = null;

  // Reused observer scratch — cleared/overwritten at top of each fire. Safe because the
  // observer is not reentrant (Y.Doc dispatches at end of transaction; applyObjectChanges
  // does not trigger a new transaction).
  private readonly _touchedIds = new Set<string>();
  private readonly _deletedIds = new Set<string>();
  private readonly _bboxChangedIds = new Set<string>();
  private readonly _kindChangedIds = new Set<string>();
  private readonly _lockChangedIds = new Set<string>();
  // Per-transaction snapshot of Y-written ids (touched ∪ deleted), taken BEFORE Phase C
  // pollutes `touched` with derived-reroute connector ids. Read synchronously by the
  // UndoManager stack-item handlers (deep observers fire before afterTransaction).
  private readonly _lastTxObjectIds = new Set<string>();
  // Scratch bbox reused across every upsert in a single fire. `upsertHandle` copies its
  // values into `handle.bbox` (or seeds a fresh tuple on first insert) — the scratch never
  // leaks into `objectsById`.
  private readonly _newBBoxScratch: BBoxTuple = [0, 0, 0, 0];

  constructor(roomId: RoomId) {
    this.roomId = roomId;

    this.userId = getUserId();

    this.ydoc = new Y.Doc({ guid: roomId });
    this.objects = this.ydoc.getMap('objects') as YObjects;

    // Lock table is a leaf module (see its header) — inject its two external needs.
    bindLockTable(this.objectsById, notifyLockVeil);

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
    if (this.undoManager) return;

    // ySyncPluginKey is added lazily by TextCollaboration.onCreate (editor mount) —
    // editor text edits tagged with it stay room-level undoable without pulling
    // @tiptap/y-tiptap into the eager bundle. No ySync transactions exist before the
    // first edit, so room-connect tracking only userId is behaviorally identical.
    this.undoManager = new Y.UndoManager([this.objects], {
      trackedOrigins: new Set([this.userId]),
      captureTimeout: 500,
    });
    this.unbindHistory = bindUndoManagerToHistoryStore(this.undoManager);
    this.unbindUndoMeta = this.attachUndoMetaCapture(this.undoManager);
  }

  /**
   * Stamp every StackItem with the set of object ids its transaction(s) wrote, so
   * `undo()`/`redo()` can vet the top item against live ephemeral locks before popping.
   * 'stack-item-added' fires for new items (incl. `type:'redo'` items minted during undo —
   * their ids come from the undo transaction's own observer fire); 'stack-item-updated'
   * fires on captureTimeout merges and unions into the existing set (covers the editors'
   * 600s-session captureTimeout too). Origin-agnostic: ySync-tagged editor transactions
   * flow through the same deep observer. Mirrors the stackItem.meta precedent in
   * core/text/extensions.ts.
   */
  private attachUndoMetaCapture(um: Y.UndoManager): () => void {
    const onAdded = ({ stackItem }: { stackItem: Y.UndoManager['undoStack'][number] }) => {
      stackItem.meta.set(UNDO_TOUCHED_IDS, new Set(this._lastTxObjectIds));
    };
    const onUpdated = ({ stackItem }: { stackItem: Y.UndoManager['undoStack'][number] }) => {
      const ids = stackItem.meta.get(UNDO_TOUCHED_IDS) as Set<string> | undefined;
      if (ids) for (const id of this._lastTxObjectIds) ids.add(id);
      else stackItem.meta.set(UNDO_TOUCHED_IDS, new Set(this._lastTxObjectIds));
    };
    um.on('stack-item-added', onAdded);
    um.on('stack-item-updated', onUpdated);
    return () => {
      um.off('stack-item-added', onAdded);
      um.off('stack-item-updated', onUpdated);
    };
  }

  mutate(fn: () => void): void {
    if (this.destroyed) return;
    this.ydoc.transact(fn, this.userId);
  }

  undo(): void {
    if (this.destroyed) return;
    const um = this.undoManager;
    if (!um || this.isStackTopBlocked(um.undoStack)) return;
    um.undo();
  }

  redo(): void {
    if (this.destroyed) return;
    const um = this.undoManager;
    if (!um || this.isStackTopBlocked(um.redoStack)) return;
    um.redo();
  }

  /**
   * Undo/redo gate — silent no-op while the top stack item touches an object a peer is
   * mid-gesture on (ephemeral remote lock). Self-resolving: the peer's release unblocks.
   * Deliberately does NOT consult the durable `locked` flag — history writes through
   * persistent locks (Figma semantics; keeps every stack item reachable). Ids without a
   * live handle (deleted objects) can't be locked: undoing a field edit on a top-level-
   * deleted object is a yjs no-op, undo-of-own-delete resurrects — both fine. Missing
   * meta (pre-capture item — impossible in practice, stacks don't persist) → allow.
   * Accepted residual: yjs pops past zero-change items to the next one unvetted — needs
   * a peer-delete/overwrite race AND a lock below; degrades to the old baseline.
   */
  private isStackTopBlocked(stack: readonly Y.UndoManager['undoStack'][number][]): boolean {
    const top = stack[stack.length - 1];
    if (!top) return false;
    const ids = top.meta.get(UNDO_TOUCHED_IDS) as ReadonlySet<string> | undefined;
    if (!ids) return false;
    const lo = getLockOwners();
    for (const id of ids) {
      const h = this.objectsById.get(id);
      if (h !== undefined && lo[h.slot] > 1) return true;
    }
    return false;
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
    detachLocks();

    this.websocketProvider = dispose(this.websocketProvider, (p) => {
      p.disconnect();
      p.destroy();
    });
    this.unbindHistory = dispose(this.unbindHistory, (fn) => fn());
    this.unbindUndoMeta = dispose(this.unbindUndoMeta, (fn) => fn());
    this.undoManager = dispose(this.undoManager, (m) => m.destroy());
    this.objectsObserver = dispose(this.objectsObserver, (fn) => this.objects.unobserveDeep(fn));

    spatialTree.clear();

    // Clear connector router state before object-cache teardown.
    this.connectorRouter.clear();

    this.zOrder.clear();

    resetLockTable();
    resetSlotTable();

    // Drop UI selection so stale selectedIds don't render against the next room's objects.
    useSelectionStore.getState().clearSelection();

    // Reset the server-delivered mode/access flags so the next room starts at 'connecting'.
    resetRoomSession();

    // Clear all object caches (geometry + layout)
    clearAllObjectCaches();

    // Terminate the lezer worker pool (re-created lazily in the next room). Kept out of
    // clearAllObjectCaches() — that also runs on hydrate, which must NOT kill the pool.
    terminateCodeWorkers();

    this.objectsById.clear();

    this.ydoc.destroy();
  }

  // Objects observer (deep observer on objects Y.Map)
  private setupObjectsObserver(): void {
    if (this.objectsObserver) return; // idempotent

    this.objectsObserver = (events) => {
      const touched = this._touchedIds,
        deleted = this._deletedIds,
        router = this.connectorRouter;
      touched.clear();
      deleted.clear();
      this._kindChangedIds.clear();
      this._lockChangedIds.clear();

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

          // In-place kind conversion (text ↔ note ↔ shape). Eviction by the OLD kind
          // MUST precede Phase B — computeBBoxForInto repopulates the new kind's
          // subsystem caches and would otherwise read stale entries (Path2D, text
          // cache incl. note-derived fontSize). removeObjectCaches(old) covers the
          // union of conversion staleness for kinds {text, note, shape}.
          if (ev.keysChanged.has('kind')) {
            const handle = this.objectsById.get(id);
            if (handle && kind && handle.kind !== kind) {
              removeObjectCaches(id, handle.kind);
              handle.kind = kind;
              this._kindChangedIds.add(id);
              // Effective outline changed even when the bbox doesn't — Phase B's
              // bbox-gated propagation can't cover that case. Set-deduped otherwise.
              router.onBindableChanged(id);
              // →shape: label layout is lazy (first drawShapeLabel), but the menu
              // reads getInlineStyles synchronously after the bridge — eagerly
              // re-tokenize + layout. (invalidateContent would no-op on the
              // just-evicted entry; getLayout creates a fresh one.)
              if (kind === 'shape') {
                const content = getContent(yObj);
                if (content) textLayoutCache.getLayout(id, content, getFontSize(yObj), getFontFamily(yObj));
              }
            }
          }

          if (kind === 'connector') {
            const startEnd = ev.keysChanged.has('start') || ev.keysChanged.has('end');
            if (startEnd || ev.keysChanged.has('connectorType')) {
              router.onConnectorEdited(id, yObj, startEnd);
            }
            // Caps bake into the cached Path2D — pre-evict so a cap-only toggle rebuilds it.
            if (ev.keysChanged.has('startCap') || ev.keysChanged.has('endCap')) {
              evictGeometry(id);
            }
            // Label removed (empty-close deleted the four fields) → drop the stranded
            // text-layout entry. Phase B's computeBBox then unions nothing → bbox shrinks
            // to the polyline. Add/edit goes through invalidateContent / computeBBox.
            if (ev.keysChanged.has('content') && !(getContent(yObj) instanceof Y.XmlFragment)) {
              textLayoutCache.evict(id);
            }
          } else if (kind === 'shape' && ev.keysChanged.has('shapeType')) {
            evictGeometry(id); // pre-evict Path2D so renderer doesn't re-check per draw
            router.onBindableChanged(id);
          }

          // Durable lock keychange: mirror onto the lock-table column synchronously.
          // No eviction, no veil poke — repaint rides the generic touched invalidate.
          if (ev.keysChanged.has('locked')) {
            const handle = this.objectsById.get(id);
            if (handle) {
              setLockedFlag(handle.slot, getLocked(yObj) ? 1 : 0);
              this._lockChangedIds.add(id);
            }
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
            const lang = getLanguage(yObj);
            codeSystem.handleContentChange(id, ev, lang);
          } else if (content instanceof Y.XmlFragment) {
            textLayoutCache.invalidateContent(id, content);
          }
        }
      }

      // Snapshot Y-written ids for the UndoManager meta capture BEFORE Phase C adds
      // derived-reroute connector ids to `touched` (those had no Y-write — including
      // them would spuriously block undo while a peer merely holds an attached connector).
      const snap = this._lastTxObjectIds;
      snap.clear();
      for (const id of touched) snap.add(id);
      for (const id of deleted) snap.add(id);

      if (touched.size === 0 && deleted.size === 0) return;
      this.applyObjectChanges();
    };

    this.objects.observeDeep(this.objectsObserver);
  }

  private applyObjectChanges(): void {
    const touched = this._touchedIds,
      deleted = this._deletedIds,
      changed = this._bboxChangedIds,
      scratch = this._newBBoxScratch,
      router = this.connectorRouter;
    changed.clear();
    const vp = getVisibleBoundsTuple();

    // === PHASE A: deletions === (router maps already updated in observer)
    for (const id of deleted) {
      const handle = this.objectsById.get(id);
      if (!handle) continue;
      spatialTree.remove(handle.slot); // slot-keyed consumer — must finalize before releaseSlot below
      lockSlotReleased(handle.slot); // lock columns + peer prune (+ veil poke)
      this.zOrder.noteRemove(handle.z);
      // releaseSlot LAST among the slot-keyed ops: a slot is freed only after every slot-keyed
      // consumer has finalized — Phase B of this same fire can recycle it (LIFO), and a late
      // spatialTree.remove(slot) would delete the RECYCLED entry.
      releaseSlot(handle.slot);
      removeObjectCaches(id, handle.kind);
      invalidateIfVisible(handle.bbox, vp); // local var — safe after release
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

    // Kind-conversion bridge BEFORE onObjectsChanged — refreshStyles must run
    // against the recomputed selection composition (selectionKind/kindCounts/mode).
    if (this._kindChangedIds.size > 0) sel.onObjectsKindChanged(this._kindChangedIds);

    // Durable-lock bridge — recompose/prune the selection so `selectionLocked` and the
    // context-menu bar react in the same beat as the keychange.
    if (this._lockChangedIds.size > 0) sel.onObjectsLockChanged(this._lockChangedIds);

    sel.onObjectsChanged(touched, changed);
  }

  /**
   * Insert/update a handle in place. On first insert, allocates the ObjectHandle once
   * (via `createHandle`) with its own owned `bbox` tuple cloned from `newBBox`, then
   * registers the slot columns and guard-inserts into the tree (the duplicate tripwire).
   *
   * SOLE-WRITER CONTRACT: the update branch's tripartite write — `handle.bbox` tuple
   * (`copyBbox`), global slot column (`writeSlotBBox`), tree entry (`spatialTree.update`)
   * — is the ONLY post-creation bbox writer path in the app; the three always move
   * together, and only here. In-place mutation is safe because no downstream consumer
   * holds a bbox ref across observer fires (transform/topology/image-manager snapshot at
   * gesture begin; renderer and pickers destructure on read).
   *
   * `spatialTree.update()` is an upsert, but relies on: handle exists ⇒ slot in tree
   * (guarded insert below + hydrate bulk load + observer-attaches-after-hydrate make an
   * absent slot unreachable). Ordering: publish the prev rect BEFORE the write (the only
   * ordering hazard left — old-rect-before-write); the tree itself needs no envelope
   * choreography (slot-keyed remove/update, no descent by old box).
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
      const slot = acquireSlot();
      lockSlotAcquired(slot);
      if (getLocked(yObj)) setLockedFlag(slot, 1); // seed the durable-lock column (create / remote add / undo-of-delete)
      const fresh = createHandle(id, kind, yObj, newBBox, z, slot);
      registerHandle(fresh); // reverse map + global bbox column
      this.zOrder.noteAdd(z);
      this.objectsById.set(id, fresh);
      spatialTree.insert(slot, newBBox[0], newBBox[1], newBBox[2], newBBox[3]); // guarded — duplicate slot throws
      evictGeometry(id);
      invalidateWorldSlot(slot); // column fresh post-registerHandle
      return true;
    }

    const bboxChanged = !bboxEquals(handle.bbox, newBBox);

    if (bboxChanged) {
      invalidateIfVisible(handle.bbox, vp); // prev rect — handle.bbox still old
      copyBbox(newBBox, handle.bbox); // tuple
      writeSlotBBox(handle.slot, newBBox); // column
      spatialTree.update(handle.slot, newBBox[0], newBBox[1], newBBox[2], newBBox[3]); // tree
    }
    if (bboxChanged || alwaysEvict) evictGeometry(id);
    // New rect — always (content may change visually with an identical bbox). On the
    // no-change path the column ≡ tuple still holds: registerHandle seeds, the block
    // above is the sole writer.
    invalidateWorldSlot(handle.slot);

    // Remote-locked ink changed (the lock holder moved/restyled it) → re-raster the veil.
    if (getLockOwners()[handle.slot] > 1) markLockVeilDirty();

    return bboxChanged;
  }

  // Hydrate from Y.Map
  private hydrateObjectsFromY(): void {
    this.objectsById.clear();
    spatialTree.clear();
    this.connectorRouter.clear();
    this.zOrder.clear();
    // Slot + lock resets FIRST, with the other clears — mandatory, not tidiness: durable-lock
    // flags are seeded inline per pass below, and an end-of-hydrate resetLockTable() would
    // wipe them. Safe here: hydrate is synchronous init — WS (and any lock traffic) attaches
    // only after; incoming lock frames buffer until 'sync'.
    resetSlotTable();
    resetLockTable();
    clearAllObjectCaches();

    const deferredConnectorIds: string[] = [];

    // Pass 1: build handles for everything except connectors. Connectors only get
    // their anchorIds + shapeToConnectors entries here — bbox + route deferred to pass 2.
    // `computeBBoxFor` populates each kind's subsystem cache (image meta + text/code/
    // note/bookmark layout) so the immediately-following hydrateImages() reads them.
    // Slots are acquired inline against the fresh table, so they come out dense
    // [0..N-1] in creation order — identical numbering to the old deferred-load path.
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
      const slot = acquireSlot();
      lockSlotAcquired(slot);
      if (getLocked(yObj)) setLockedFlag(slot, 1); // durable-lock seed, inline (no trailing sweep)
      const handle = createHandle(id, kind, yObj, bbox, z, slot);
      registerHandle(handle);
      this.zOrder.noteAdd(z);
      this.objectsById.set(id, handle);
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
      const slot = acquireSlot();
      lockSlotAcquired(slot);
      if (getLocked(yObj)) setLockedFlag(slot, 1);
      const handle = createHandle(id, 'connector', yObj, bbox, z, slot);
      registerHandle(handle);
      this.zOrder.noteAdd(z);
      this.objectsById.set(id, handle);
    }

    // OMT bulk load straight off the global bbox column: hydrate starts from
    // resetSlotTable with no frees, so slots are dense [0..N-1] and item-index
    // === slot — the slot-indexed column IS load()'s item-indexed layout (it
    // subarrays the longer buffer). Cold alloc OK. Connector routing-failure
    // [0,0,0,0] boxes are valid finite min≤max entries — same spurious-near-
    // origin behavior as before; the next observer fire corrects them.
    const n = slotHighWater();
    if (n > 0) {
      const ids = new Uint32Array(n);
      for (let i = 0; i < n; i++) ids[i] = i;
      spatialTree.load(n, ids, getBBoxColumn());
    }

    hydrateImages();
    invalidateWorldAll();
  }

  private async initializeIndexedDBProvider(): Promise<void> {
    try {
      this.indexeddbProvider = new IndexeddbPersistence(ROOM_DOC_DB_PREFIX + this.roomId, this.ydoc);
      await Promise.race([this.indexeddbProvider.whenSynced, new Promise<void>((resolve) => setTimeout(resolve, 1000))]).catch(() => {});
    } catch (err) {
      console.error('[RoomDocManager] IDB initialization failed (non-critical):', err);
    }
  }

  private initializeWebSocketProvider(): void {
    try {
      // prod: sync.avlo.io (cross-origin, cookie rides via Domain=.avlo.io); dev: the Vite
      // host (localhost:<vite>) so the /sync proxy forwards the upgrade to the sync worker.
      const host = SYNC_HOST_PROD ?? window.location.host;

      this.websocketProvider = new YProvider(host, this.roomId, this.ydoc, {
        connect: true,
        // `prefix` (vs `party`) makes the provider use the path verbatim, so we bake the
        // `rooms` party segment + roomId in: wss://sync.avlo.io/sync/rooms/<id> (prod) /
        // ws://localhost:<vite>/sync/rooms/<id> (dev via Vite proxy). Must match SYNC_WS_PREFIX.
        prefix: `/${SYNC_WS_PREFIX}/rooms/${this.roomId}`,
        maxBackoffTime: 10_000,
        resyncInterval: -1,
      });

      // Attach presence module to provider's awareness
      attach(this.websocketProvider, (wsConnected) => {
        this.wsConnected = wsConnected;
        if (!wsConnected) this.wsRepacked = false;
      });

      // Ephemeral lock wire: messageHandlers[MSG_LOCK] + buffer-until-sync + lease egress.
      attachLocks(this.websocketProvider);

      // Listen for sync status — repack spatial index on first sync per connection
      this.websocketProvider.on('sync', (isSynced: boolean) => {
        if (isSynced && !this.wsRepacked) {
          this.repackSpatialIndex();
          this.wsRepacked = true;
        }
      });

      // Close-code policy (H27): the stock provider blindly reconnects on EVERY close.
      // 4401/4403 are terminal — record the denial + disconnect so the retry loop stops.
      // 1006/1008/transient closes fall through to the provider's auto-reconnect.
      this.websocketProvider.on('connection-close', (event: CloseEvent) => {
        if (event.code !== 4401 && event.code !== 4403) return;
        setRoomAccess(event.code === 4401 ? 'unauthenticated' : 'forbidden');
        this.websocketProvider?.disconnect();
        // 4401 (auth hiccup, possibly transient) gets none of the destructive handling.
        if (event.code !== 4403) return;

        // 4403 = private + not owner, by definition. Drop every local trace and leave —
        // with persistence deleted and the WS dead, a still-interactive canvas would
        // silently discard every further edit.
        removeRoom(this.roomId);
        // Patch the stale cached row (e.g. 'public') so the merge hides it before the
        // next refetch lands.
        queryClient.setQueryData<RoomsQueryData>(ROOMS_QUERY_KEY, (data) =>
          data ? { ...data, rooms: data.rooms.map((r) => (r.roomId === this.roomId ? { ...r, permission: 'private' } : r)) } : data,
        );
        // Authoritatively refetch the dashboard: the server redacts/prunes the now-forbidden
        // row, so the in-memory patch above is just the instant-hide; this purges the cache on
        // rejection instead of leaning on natural staleness (kills a back/forward ghost row).
        void queryClient.invalidateQueries({ queryKey: ROOMS_QUERY_KEY });
        // y-indexeddb destroy-and-delete: clearData() unhooks the update listener BEFORE
        // deleting, so the live Y.Doc can't re-persist; the dispose chain's later
        // destroy() is a harmless no-op on the nulled field.
        this.indexeddbProvider = dispose(this.indexeddbProvider, (p) => void p.clearData());
        void router.navigate({ to: '/home' });
      });

      // Server-pushed session state arrives out-of-band as prefixed custom messages (the
      // provider already stripped the `__YPS:` prefix). `mode:` — effective editor/viewer
      // (stored only; viewer gating deferred, §17 step 8). `title:` — pushed on connect +
      // rebroadcast on every rename. `owner:` — per-connection ownership flag (gates the
      // rename affordance; enforcement stays in the DO). `perm:` — room-wide permission
      // (drives the Share modal + dashboard Type column); the `owner:`/`perm:` values
      // also mirror into the persisted facts (update-only — a 4403-pruned room's absent
      // row is never recreated by a late push).
      this.websocketProvider.on('custom-message', (message: string) => {
        if (message.startsWith('mode:')) setRoomMode(message.slice(5) === 'viewer' ? 'viewer' : 'editor');
        else if (message.startsWith('title:')) setRoomTitle(message.slice(6));
        else if (message.startsWith('owner:')) {
          const isOwner = message.slice(6) === '1';
          setRoomIsOwner(isOwner);
          setRoomOwnerFact(this.roomId, isOwner);
        } else if (message.startsWith('perm:')) {
          const parsed = Permission.safeParse(message.slice(5));
          if (parsed.success) {
            setRoomPermission(parsed.data);
            setRoomPermissionFact(this.roomId, parsed.data);
          }
        }
      });
    } catch (err: unknown) {
      console.error('[RoomDocManager] WebSocket initialization failed:', err);
    }
  }

  // Repack in place from the tree's own live entries — provenance changed from the
  // old clear+load-from-objectsById: the accidental self-healing that gave is unneeded
  // (guarded insert + ordered remove leave no divergence path between tree and handles).
  private repackSpatialIndex(): void {
    spatialTree.rebuild();
  }

  public isConnected(): boolean {
    return this.wsConnected;
  }
}
