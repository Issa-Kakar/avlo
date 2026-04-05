/**
 * RoomDocManager - Central authority for Y.Doc and real-time collaboration
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import YProvider from 'y-partyserver/provider';
import { userProfileManager } from './user-profile-manager';
import type { RoomId } from '@avlo/shared';
import type { Snapshot } from '@/types/snapshot';
import { ObjectSpatialIndex } from '@/lib/spatial';
import type { ObjectHandle, ObjectKind } from '@/types/objects';
import type { BBoxTuple } from '@/types/geometry';
import { computeBBoxFor, bboxEquals } from '@/lib/geometry/bbox';
import { getObjectCacheInstance } from '@/renderer/object-cache';
import { invalidateWorldBBox, invalidateWorldAll } from '@/canvas/invalidation-helpers';
import { getVisibleWorldBounds } from '@/stores/camera-store';
import {
  initConnectorLookup,
  hydrateConnectorLookup,
  clearConnectorLookup,
  processConnectorAdded,
  processConnectorUpdated,
  processConnectorDeleted,
  processShapeDeleted,
} from './connectors';
import { getTextProps } from '@/lib/object-accessors';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { textLayoutCache, computeTextBBox, computeNoteBBox } from './text/text-system';
import { getNoteProps } from '@/lib/object-accessors';
import { codeSystem, computeCodeBBox } from './code/code-system';
import { getCodeProps } from '@/lib/object-accessors';
import { useSelectionStore } from '@/stores/selection-store';
import { hydrateImages } from '@/lib/image/image-manager';
import { invalidateBookmarkLayout, clearBookmarkLayouts } from '@/lib/bookmark/bookmark-render';
import { initPresenceIdentity, attach, detach } from './presence';

type Unsub = () => void;

// Type alias for Y structures
type YObjects = Y.Map<Y.Map<unknown>>;

// Manager interface - public API
export interface IRoomDocManager {
  readonly objects: YObjects;
  readonly objectsById: ReadonlyMap<string, ObjectHandle>;
  readonly spatialIndex: ObjectSpatialIndex;

  readonly currentSnapshot: Snapshot;
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;

  mutate(fn: () => void): void;
  destroy(): void;
  undo(): void;
  redo(): void;
  getUndoManager(): Y.UndoManager | null;

  isConnected(): boolean;
}

// Options for RoomDocManager (currently empty, but preserved for future use)
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
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

  // Current state
  private _currentSnapshot: Snapshot;

  // Subscription management
  private snapshotSubscribers = new Set<(snap: Snapshot) => void>();

  // Track if destroyed for cleanup
  private destroyed = false;

  // Document version tracking
  private docVersion = 0;

  // Connection tracking
  private wsConnected = false;
  private wsRepacked = false;

  // Y.Map-based object storage
  readonly objectsById = new Map<string, ObjectHandle>();
  readonly spatialIndex = new ObjectSpatialIndex();
  private objectsObserver: ((events: Y.YEvent<any>[], tx: Y.Transaction) => void) | null = null;

  constructor(roomId: RoomId, _options?: RoomDocManagerOptions) {
    this.roomId = roomId;

    const identity = userProfileManager.getIdentity();
    this.userId = identity.userId;

    this.ydoc = new Y.Doc({ guid: roomId });
    this.objects = this.ydoc.getMap('objects') as YObjects;
    initPresenceIdentity();

    // Initial snapshot references our live (empty) instances
    this._currentSnapshot = {
      docVersion: 0,
      objectsById: this.objectsById,
      spatialIndex: this.spatialIndex,
    };

    // Y.Doc-level update observer (before IDB to catch updates)
    this.setupObservers();

    // Async init: IDB → hydrate → observer → UndoManager → WS
    void this.init();
  }

  private async init(): Promise<void> {
    // 1. IDB sync with 1s timeout
    await this.initializeIndexedDBProvider();
    if (this.destroyed) return;

    // 2. Init connector lookup + hydrate from IDB data (first STR bulk load)
    initConnectorLookup();
    this.hydrateObjectsFromY();
    this.publishSnapshotNow();

    // 3. Attach deep observer AFTER hydrate (critical ordering)
    this.setupObjectsObserver();

    // 4. UndoManager
    this.attachUndoManager();

    // 5. WS provider (sync listener handles repack)
    if (!this.destroyed) this.initializeWebSocketProvider();
  }

  // Public getters
  get currentSnapshot(): Snapshot {
    return this._currentSnapshot;
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

  // Subscription methods
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub {
    if (this.destroyed) {
      return () => {};
    }

    this.snapshotSubscribers.add(cb);
    cb(this._currentSnapshot);

    return () => {
      this.snapshotSubscribers.delete(cb);
    };
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

    // Remove Y.Doc observers
    this.ydoc.off('updateV2', this.handleYDocUpdate);

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

    // Clear connector lookup
    clearConnectorLookup();

    // Clear layout caches
    textLayoutCache.clear();
    codeSystem.clear();
    clearBookmarkLayouts();

    // Clear object maps
    this.objectsById.clear();

    // Clear subscriptions
    this.snapshotSubscribers.clear();

    // Destroy Y.Doc
    this.ydoc.destroy();
  }

  // Phase 2.4 Component B: Y.Doc Observer Setup
  private setupObservers(): void {
    this.ydoc.on('updateV2', this.handleYDocUpdate);
  }

  // ============================================================
  // PART 2: Objects Observers (Deep observer on objects Y.Map)
  // ============================================================
  private setupObjectsObserver(): void {
    if (this.objectsObserver) return; // idempotent

    this.objectsObserver = (events, _tx) => {
      const touchedIds = new Set<string>();
      const deletedIds = new Set<string>();

      for (const ev of events) {
        // Top-level object adds/deletes
        if (ev.target === this.objects && ev instanceof Y.YMapEvent) {
          for (const [key, change] of ev.changes.keys) {
            const id = String(key);
            if (change.action === 'delete') {
              deletedIds.add(id);
            } else {
              touchedIds.add(id);
            }
          }
          continue;
        }

        // Nested changes - path[0] is object ID
        const path = ev.path as (string | number)[];
        const id = String(path[0] ?? '');
        if (!id) continue;

        touchedIds.add(id);

        // Y.XmlFragment change: invalidate text cache (eager re-tokenize for inline styles)
        // Y.Text change (code blocks): sync tokenize + dispatch to Lezer worker
        if (path.length >= 2 && String(path[1] ?? '') === 'content') {
          const yObj = this.objects.get(id);
          const content = yObj?.get('content');
          const kind = yObj?.get('kind') as string | undefined;
          if (kind === 'code' && ev instanceof Y.YTextEvent) {
            const lang = getCodeProps(yObj!)?.language ?? 'javascript';
            codeSystem.handleContentChange(id, ev, lang);
          } else if (content instanceof Y.XmlFragment) {
            textLayoutCache.invalidateContent(id, content);
          }
        }
      }

      if (touchedIds.size === 0 && deletedIds.size === 0) return;

      this.applyObjectChanges(touchedIds, deletedIds);
    };

    this.objects.observeDeep(this.objectsObserver);
  }

  private applyObjectChanges(touchedIds: Set<string>, deletedIds: Set<string>): void {
    const dirtyBBoxes: BBoxTuple[] = [];
    const cache = getObjectCacheInstance();

    // Process deletions
    for (const id of deletedIds) {
      const handle = this.objectsById.get(id);
      if (!handle) continue;

      this.spatialIndex.remove(id, handle.bbox);
      cache.evict(id);
      dirtyBBoxes.push(handle.bbox);

      this.objectsById.delete(id);

      if (handle.kind === 'connector') {
        processConnectorDeleted(id);
      } else {
        processShapeDeleted(id);
      }

      if (handle.kind === 'text' || handle.kind === 'shape' || handle.kind === 'note') {
        textLayoutCache.remove(id);
      }
      if (handle.kind === 'code') {
        codeSystem.remove(id);
      }
      if (handle.kind === 'bookmark') {
        invalidateBookmarkLayout(id);
      }
    }

    // Process additions/updates
    const sel = useSelectionStore.getState();
    const editingId = sel.textEditingId;
    const selectedSet = sel.selectedIdSet;
    let needsRefresh = false;
    let needsReposition = false;

    // Deletion bridge
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

    for (const id of touchedIds) {
      const yObj = this.objects.get(id);
      if (!yObj) continue;

      const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';
      const prev = this.objectsById.get(id);
      const oldBBox = prev?.bbox ?? null;

      let newBBox: [number, number, number, number];
      if (kind === 'note') {
        const props = getNoteProps(yObj);
        newBBox = props ? computeNoteBBox(id, props) : computeBBoxFor(kind, yObj);
      } else if (kind === 'text') {
        const props = getTextProps(yObj);
        newBBox = props ? computeTextBBox(id, props) : computeBBoxFor(kind, yObj);
      } else if (kind === 'code') {
        newBBox = computeCodeBBox(id, yObj);
      } else {
        newBBox = computeBBoxFor(kind, yObj);
      }

      const handle: ObjectHandle = { id, kind, y: yObj, bbox: newBBox };
      this.objectsById.set(id, handle);

      if (oldBBox) {
        this.spatialIndex.update(id, oldBBox, newBBox, kind);
      } else {
        this.spatialIndex.insert(id, newBBox, kind);
      }

      if (kind === 'connector') {
        if (oldBBox) {
          processConnectorUpdated(id, yObj);
        } else {
          processConnectorAdded(id, yObj);
        }
      }

      if (!oldBBox) {
        dirtyBBoxes.push(newBBox);
      } else {
        const bboxChanged = !bboxEquals(oldBBox, newBBox);
        if (bboxChanged) {
          cache.evict(id);
          dirtyBBoxes.push(oldBBox);
          dirtyBBoxes.push(newBBox);
        } else {
          if (kind === 'shape') cache.evict(id);
          dirtyBBoxes.push(newBBox);
        }
      }

      if (selectedSet.has(id) || id === editingId) {
        needsRefresh = true;
        if (!oldBBox || !bboxEquals(oldBBox, newBBox)) needsReposition = true;
      }
    }

    if (needsRefresh) useSelectionStore.getState().refreshStyles();
    if (needsReposition)
      useSelectionStore.setState((s) => ({ boundsVersion: s.boundsVersion + 1 }));

    this.flushDirtyBBoxes(dirtyBBoxes);
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
    getObjectCacheInstance().clear();
    textLayoutCache.clear();
    codeSystem.clear();
    clearBookmarkLayouts();

    const handles: ObjectHandle[] = [];
    this.objects.forEach((yObj, key) => {
      const id = String(key);
      const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';

      let bbox: [number, number, number, number];
      if (kind === 'note') {
        const props = getNoteProps(yObj);
        bbox = props ? computeNoteBBox(id, props) : computeBBoxFor(kind, yObj);
      } else if (kind === 'text') {
        const props = getTextProps(yObj);
        bbox = props ? computeTextBBox(id, props) : computeBBoxFor(kind, yObj);
      } else if (kind === 'code') {
        bbox = computeCodeBBox(id, yObj);
      } else {
        bbox = computeBBoxFor(kind, yObj);
      }

      const handle: ObjectHandle = { id, kind, y: yObj, bbox };
      this.objectsById.set(id, handle);
      handles.push(handle);
    });

    if (handles.length > 0) {
      this.spatialIndex.bulkLoad(handles);
    }

    hydrateConnectorLookup(this.objectsById);
    hydrateImages(this.objects);
    invalidateWorldAll();
  }

  // Arrow function property ensures stable reference for event listener cleanup
  private handleYDocUpdate = (_update: Uint8Array, _origin: unknown): void => {
    this.docVersion = (this.docVersion + 1) >>> 0;
    this.publishSnapshotNow();
  };

  private async initializeIndexedDBProvider(): Promise<void> {
    try {
      const dbName = `avlo.v1.rooms.${this.roomId}`;
      this.indexeddbProvider = new IndexeddbPersistence(dbName, this.ydoc);
      await Promise.race([
        this.indexeddbProvider.whenSynced,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]).catch(() => {});
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

  // ============================================================
  // PART 5: Event-Driven Snapshot Publishing
  // ============================================================

  private publishSnapshotNow(): void {
    const snap: Snapshot = {
      docVersion: this.docVersion,
      objectsById: this.objectsById,
      spatialIndex: this.spatialIndex,
    };
    this._currentSnapshot = snap;
    this.snapshotSubscribers.forEach((cb) => {
      try {
        cb(snap);
      } catch (e) {
        console.error('[Snapshot] Subscriber error:', e);
      }
    });
  }
}
