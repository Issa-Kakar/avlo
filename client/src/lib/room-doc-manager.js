if (typeof globalThis.requestAnimationFrame === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.requestAnimationFrame = (callback) => {
        return setTimeout(callback, 16); // ~60fps
    };
}
if (typeof globalThis.cancelAnimationFrame === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.cancelAnimationFrame = (id) => {
        clearTimeout(id);
    };
}
import * as Y from 'yjs';
import { createEmptySnapshot, // Regular import, not type import - function needs to be callable
ROOM_CONFIG, // Will be used in Phase 2.5
TEXT_CONFIG, } from '@avlo/shared';
// Private implementation
class RoomDocManagerImpl {
    // Core properties
    roomId;
    ydoc;
    // NOTE: No cached Y structure references - all access via helper methods
    // Providers (will be null initially, added in later phases)
    indexeddbProvider = null;
    websocketProvider = null;
    webrtcProvider = null;
    // Current state
    _currentSnapshot;
    // Subscription management
    snapshotSubscribers = new Set();
    presenceSubscribers = new Set();
    statsSubscribers = new Set();
    // Phase 2.4 Component A: Snapshot Publisher State
    publishState = {
        rafId: 0,
        isDirty: false,
        lastPublishTime: 0,
        publishWorkMs: 0, // Track how long publish takes
        isHidden: false,
        batchWindow: 16, // Start with default 16ms
        pendingUpdates: [],
        lastSvKey: '', // Track to detect changes
    };
    // IndexedDB cache for render snapshots
    snapshotCache = null;
    SNAPSHOT_CACHE_DB = 'avlo-snapshot-cache';
    SNAPSHOT_CACHE_VERSION = 1;
    // Track cleanup handlers
    cleanupHandlers = [];
    // Room stats tracking (for Phase 2.5)
    roomStats = null;
    constructor(roomId) {
        this.roomId = roomId;
        // CRITICAL: Create Y.Doc with guid matching roomId
        this.ydoc = new Y.Doc({ guid: roomId });
        // Initialize Yjs structures
        this.initializeYjsStructures();
        // Validate structure integrity
        if (!this.validateStructure()) {
            throw new Error('Failed to initialize Y.Doc structure');
        }
        // CRITICAL: Initialize with EmptySnapshot (NEVER null)
        this._currentSnapshot = createEmptySnapshot();
        // Phase 2.4: Setup snapshot publishing (NO await)
        this.initSnapshotCache(); // Async but don't await
        this.setupObservers();
        this.setupVisibilityHandling();
        this.startPublishLoop();
        // ❌ DO NOT cache Y structure references:
        // this.yStrokes = ...             // WRONG
        // this.yMeta = ...                // WRONG
        // ✅ Always access through helper methods
    }
    // Public getters
    get currentSnapshot() {
        return this._currentSnapshot;
    }
    // CRITICAL: These are PRIVATE helpers for internal use only
    // NEVER expose these to external code or cache their return values
    // Each call must go through the helper to ensure encapsulation
    getRoot() {
        return this.ydoc.getMap('root');
    }
    getMeta() {
        const meta = this.getRoot().get('meta');
        if (!(meta instanceof Y.Map)) {
            throw new Error('Meta structure corrupted');
        }
        return meta;
    }
    getSceneTicks() {
        const meta = this.getMeta();
        const ticks = meta.get('scene_ticks');
        if (!(ticks instanceof Y.Array)) {
            throw new Error('Scene ticks structure corrupted');
        }
        return ticks;
    }
    getStrokes() {
        const strokes = this.getRoot().get('strokes');
        if (!(strokes instanceof Y.Array)) {
            throw new Error('Strokes structure corrupted');
        }
        return strokes;
    }
    getTexts() {
        const texts = this.getRoot().get('texts');
        if (!(texts instanceof Y.Array)) {
            throw new Error('Texts structure corrupted');
        }
        return texts;
    }
    getCode() {
        const code = this.getRoot().get('code');
        if (!(code instanceof Y.Map)) {
            throw new Error('Code structure corrupted');
        }
        return code;
    }
    getOutputs() {
        const outputs = this.getRoot().get('outputs');
        if (!(outputs instanceof Y.Array)) {
            throw new Error('Outputs structure corrupted');
        }
        return outputs;
    }
    // Helper to get current scene
    getCurrentScene() {
        const sceneTicks = this.getSceneTicks();
        return sceneTicks.length;
    }
    // Helper to build presence view from awareness (stub for now, will be populated in Phase 4)
    buildPresenceView() {
        return {
            users: new Map(),
            localUserId: '',
        };
    }
    // Helper to get view transform (identity for now, will be populated in Phase 3)
    getViewTransform() {
        return {
            worldToCanvas: (x, y) => [x, y],
            canvasToWorld: (x, y) => [x, y],
            scale: 1,
            pan: { x: 0, y: 0 },
        };
    }
    // Step 3: Initialize Y.js structures with proper setup
    initializeYjsStructures() {
        this.ydoc.transact(() => {
            const root = this.ydoc.getMap('root');
            // Initialize meta if not present
            if (!root.has('meta')) {
                const meta = new Y.Map();
                const sceneTicks = new Y.Array();
                meta.set('scene_ticks', sceneTicks);
                // Canvas reference is optional per OVERVIEW.MD
                // meta.set('canvas', { baseW: 1920, baseH: 1080 }); // Optional
                root.set('meta', meta);
            }
            // Initialize strokes array
            if (!root.has('strokes')) {
                root.set('strokes', new Y.Array());
            }
            // Initialize texts array
            if (!root.has('texts')) {
                root.set('texts', new Y.Array());
            }
            // Initialize code cell
            if (!root.has('code')) {
                const code = new Y.Map();
                code.set('lang', 'javascript');
                code.set('body', '');
                code.set('version', 0);
                root.set('code', code);
            }
            // Initialize outputs array with enforcement wrapper
            if (!root.has('outputs')) {
                root.set('outputs', new Y.Array());
            }
        }, 'init'); // Origin for debugging
    }
    // Step 4: Add output with size enforcement
    addOutput(output) {
        const outputs = this.getOutputs();
        // Validate single output size
        const outputSize = new TextEncoder().encode(output.text).length;
        if (outputSize > TEXT_CONFIG.MAX_OUTPUT_BYTES_PER_RUN) {
            throw new Error(`Output exceeds ${TEXT_CONFIG.MAX_OUTPUT_BYTES_PER_RUN} bytes limit`);
        }
        this.ydoc.transact(() => {
            // Add new output
            outputs.push([output]);
            // Enforce max count (keep last N)
            while (outputs.length > TEXT_CONFIG.MAX_OUTPUTS_COUNT) {
                outputs.delete(0, 1);
            }
            // Validate total size
            let totalSize = 0;
            for (const out of outputs) {
                totalSize += new TextEncoder().encode(out.text).length;
            }
            // If total exceeds limit, remove oldest until under limit
            while (totalSize > TEXT_CONFIG.MAX_TOTAL_OUTPUT_BYTES && outputs.length > 0) {
                const removed = outputs.get(0);
                if (removed) {
                    totalSize -= new TextEncoder().encode(removed.text).length;
                }
                outputs.delete(0, 1);
            }
        }, 'add-output');
    }
    // Step 6: Validate structure integrity
    validateStructure() {
        try {
            const root = this.getRoot();
            // Check all required structures exist
            if (!root.has('meta'))
                return false;
            if (!root.has('strokes'))
                return false;
            if (!root.has('texts'))
                return false;
            if (!root.has('code'))
                return false;
            if (!root.has('outputs'))
                return false;
            // Validate meta structure
            const meta = this.getMeta();
            if (!meta.has('scene_ticks'))
                return false;
            // Validate scene_ticks is array
            const sceneTicks = meta.get('scene_ticks');
            if (!(sceneTicks instanceof Y.Array))
                return false;
            // Validate code structure
            const code = this.getCode();
            if (!code.has('lang'))
                return false;
            if (!code.has('body'))
                return false;
            if (!code.has('version'))
                return false;
            return true;
        }
        catch {
            return false;
        }
    }
    // Subscription methods
    subscribeSnapshot(cb) {
        this.snapshotSubscribers.add(cb);
        // Immediately call with current snapshot
        cb(this._currentSnapshot);
        return () => {
            this.snapshotSubscribers.delete(cb);
        };
    }
    subscribePresence(cb) {
        this.presenceSubscribers.add(cb);
        // Immediately call with current presence
        cb(this._currentSnapshot.presence);
        return () => {
            this.presenceSubscribers.delete(cb);
        };
    }
    subscribeRoomStats(cb) {
        this.statsSubscribers.add(cb);
        // Immediately call with current stats if available
        const stats = this._currentSnapshot.meta.bytes
            ? { bytes: this._currentSnapshot.meta.bytes, cap: this._currentSnapshot.meta.cap }
            : null;
        cb(stats);
        return () => {
            this.statsSubscribers.delete(cb);
        };
    }
    // Write command (stub - will be implemented with WriteQueue)
    write(cmd) {
        // eslint-disable-next-line no-console
        console.log('[RoomDocManager] Write command:', cmd.type);
        // Will be connected to WriteQueue/CommandBus in Phase 2.5
    }
    // Extend TTL (stub)
    extendTTL() {
        // eslint-disable-next-line no-console
        console.log('[RoomDocManager] Extending TTL');
        // Will be implemented with rate limiting
    }
    // Lifecycle
    destroy() {
        // eslint-disable-next-line no-console
        console.log('[RoomDocManager] Destroying');
        // Stop RAF loop
        if (this.publishState.rafId) {
            cancelAnimationFrame(this.publishState.rafId);
        }
        // Clean up observers
        this.ydoc.off('update', this.handleYDocUpdate);
        // Clean up visibility handler
        this.cleanupHandlers.forEach((cleanup) => cleanup());
        // Close IndexedDB
        this.snapshotCache?.close();
        // Clear subscribers
        this.snapshotSubscribers.clear();
        this.presenceSubscribers.clear();
        this.statsSubscribers.clear();
        // Destroy providers (when added in Phase 4)
        // this.indexeddbProvider?.destroy();
        // this.websocketProvider?.destroy();
        // this.webrtcProvider?.destroy();
        // Destroy Y.Doc
        this.ydoc.destroy();
        // Remove from registry
        RoomDocManagerRegistry.remove(this.roomId);
    }
    // Phase 2.4 Component B: Y.Doc Observer Setup
    setupObservers() {
        // CRITICAL: Use 'update' event for batching, not deep observe
        this.ydoc.on('update', this.handleYDocUpdate);
        // Optional: Track specific events for debugging
        if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
            this.ydoc.on('afterTransaction', (transaction) => {
                // eslint-disable-next-line no-console
                console.log('[Snapshot] Transaction origin:', transaction.origin);
            });
        }
    }
    handleYDocUpdate = (update, origin) => {
        // Mark dirty for next RAF
        this.publishState.isDirty = true;
        // Store update for potential analysis (optional)
        this.publishState.pendingUpdates.push({ update, origin, time: Date.now() });
        // Trim old updates beyond batch window
        const cutoff = Date.now() - this.publishState.batchWindow;
        this.publishState.pendingUpdates = this.publishState.pendingUpdates.filter((u) => u.time > cutoff);
    };
    // Phase 2.4 Component C: RAF-Based Publish Loop
    startPublishLoop() {
        const loop = () => {
            const now = performance.now();
            // Check if we should publish
            const timeSinceLastPublish = now - this.publishState.lastPublishTime;
            const minInterval = this.publishState.isHidden
                ? 125 // 8 FPS for hidden tab
                : 16.67; // 60 FPS for active tab
            if (this.publishState.isDirty && timeSinceLastPublish >= minInterval) {
                const startTime = performance.now();
                // Build and publish snapshot
                this.publishSnapshot();
                // Track publish time for adaptive batching
                this.publishState.publishWorkMs = performance.now() - startTime;
                this.publishState.lastPublishTime = now;
                this.publishState.isDirty = false;
                // Adaptive batch window based on publish time
                this.updateBatchWindow();
            }
            // Continue loop
            this.publishState.rafId = requestAnimationFrame(loop);
        };
        // Start loop
        this.publishState.rafId = requestAnimationFrame(loop);
    }
    updateBatchWindow() {
        const { publishWorkMs } = this.publishState;
        // Expand window if work takes >8ms, contract if <4ms
        if (publishWorkMs > 8) {
            this.publishState.batchWindow = Math.min(32, this.publishState.batchWindow * 1.5);
        }
        else if (publishWorkMs < 4 && this.publishState.batchWindow > 16) {
            this.publishState.batchWindow = Math.max(8, this.publishState.batchWindow * 0.8);
        }
    }
    // Phase 2.4 Component D: Visibility Handling
    setupVisibilityHandling() {
        const handleVisibilityChange = () => {
            this.publishState.isHidden = document.hidden;
            if (!this.publishState.isHidden) {
                // Force publish when becoming visible
                this.publishState.isDirty = true;
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        // Store for cleanup
        this.cleanupHandlers.push(() => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        });
    }
    // Phase 2.4 Component E: Snapshot Building & Publishing
    publishSnapshot() {
        // Build new snapshot
        const newSnapshot = this.buildSnapshot();
        // Check if svKey changed (actual Y.Doc update)
        if (newSnapshot.svKey !== this.publishState.lastSvKey) {
            this.publishState.lastSvKey = newSnapshot.svKey;
            // Cache in IndexedDB (async, don't await)
            this.cacheSnapshot(newSnapshot);
        }
        // Update current snapshot
        this._currentSnapshot = newSnapshot;
        // Notify subscribers
        this.snapshotSubscribers.forEach((cb) => {
            try {
                cb(newSnapshot);
            }
            catch (error) {
                console.error('[Snapshot] Subscriber error:', error);
            }
        });
    }
    // Phase 2.4 Component F: IndexedDB Snapshot Cache
    async initSnapshotCache() {
        try {
            const request = indexedDB.open(this.SNAPSHOT_CACHE_DB, this.SNAPSHOT_CACHE_VERSION);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('snapshots')) {
                    const store = db.createObjectStore('snapshots', { keyPath: 'key' });
                    store.createIndex('roomId', 'roomId', { unique: false });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };
            request.onsuccess = (event) => {
                this.snapshotCache = event.target.result;
                this.loadCachedSnapshot();
            };
            request.onerror = () => {
                console.warn('[Snapshot] Failed to open IndexedDB cache');
            };
        }
        catch (error) {
            console.warn('[Snapshot] IndexedDB not available:', error);
        }
    }
    async cacheSnapshot(snapshot) {
        if (!this.snapshotCache)
            return;
        try {
            const transaction = this.snapshotCache.transaction(['snapshots'], 'readwrite');
            const store = transaction.objectStore('snapshots');
            // Store only essential data (no typed arrays, minimal size)
            const cacheEntry = {
                key: `${this.roomId}:${snapshot.svKey}`,
                roomId: this.roomId,
                svKey: snapshot.svKey,
                timestamp: Date.now(),
                snapshot: {
                    scene: snapshot.scene,
                    strokes: snapshot.strokes.map((s) => ({
                        id: s.id,
                        points: s.points, // Plain array, not Float32Array
                        style: s.style,
                        bbox: s.bbox,
                        scene: s.scene,
                    })),
                    texts: snapshot.texts.map((t) => ({
                        id: t.id,
                        x: t.x,
                        y: t.y,
                        w: t.w,
                        h: t.h,
                        content: t.content,
                        style: t.style,
                        scene: t.scene,
                    })),
                    meta: snapshot.meta,
                },
            };
            // Delete old entries for this room
            const deleteReq = store.index('roomId').openCursor(IDBKeyRange.only(this.roomId));
            deleteReq.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (cursor.value.svKey !== snapshot.svKey) {
                        cursor.delete();
                    }
                    cursor.continue();
                }
            };
            // Add new entry
            store.put(cacheEntry);
        }
        catch (error) {
            console.warn('[Snapshot] Failed to cache:', error);
        }
    }
    async loadCachedSnapshot() {
        if (!this.snapshotCache)
            return;
        try {
            // Calculate current svKey
            const stateVector = Y.encodeStateVector(this.ydoc);
            // Safe base64 encoding for arbitrary bytes
            const currentSvKey = btoa(Array.from(stateVector, (byte) => String.fromCharCode(byte)).join(''));
            const transaction = this.snapshotCache.transaction(['snapshots'], 'readonly');
            const store = transaction.objectStore('snapshots');
            const request = store.get(`${this.roomId}:${currentSvKey}`);
            request.onsuccess = (event) => {
                const result = event.target.result;
                if (result && result.snapshot) {
                    // Restore snapshot for immediate render
                    this._currentSnapshot = this.reconstructSnapshot(result.snapshot, currentSvKey);
                    // Notify subscribers
                    this.snapshotSubscribers.forEach((cb) => cb(this._currentSnapshot));
                }
            };
        }
        catch (error) {
            console.warn('[Snapshot] Failed to load cache:', error);
        }
    }
    reconstructSnapshot(cached, svKey) {
        return {
            svKey,
            scene: cached.scene,
            strokes: cached.strokes.map((s) => ({
                ...s,
                polyline: null,
            })),
            texts: cached.texts,
            presence: { users: new Map(), localUserId: '' },
            spatialIndex: { _tree: null },
            view: {
                worldToCanvas: (x, y) => [x, y],
                canvasToWorld: (x, y) => [x, y],
                scale: 1,
                pan: { x: 0, y: 0 },
            },
            meta: cached.meta,
            createdAt: Date.now(),
        };
    }
    // Private: Build immutable snapshot from Y.Doc
    buildSnapshot() {
        // Get current state vector for svKey
        const stateVector = Y.encodeStateVector(this.ydoc);
        // CRITICAL: Use safe encoding to avoid stack overflow on large state vectors
        const svKey = btoa(Array.from(stateVector, (byte) => String.fromCharCode(byte)).join(''));
        // Use helper to get current scene
        const currentScene = this.getCurrentScene();
        // Build stroke views using helper (filter by current scene)
        const strokes = this.getStrokes()
            .toArray()
            .filter((s) => s.scene === currentScene)
            .map((s) => ({
            id: s.id,
            points: s.points, // Include points for renderer to build Float32Array
            // CRITICAL: Float32Array MUST be created at render time only, never in snapshot
            polyline: null, // Will be created at render time from points
            style: {
                color: s.color,
                size: s.size,
                opacity: s.opacity,
                tool: s.tool,
            },
            bbox: s.bbox,
            scene: s.scene, // CRITICAL: Include scene for causal consistency
        }));
        // Build text views using helper (filter by current scene)
        const texts = this.getTexts()
            .toArray()
            .filter((t) => t.scene === currentScene)
            .map((t) => ({
            id: t.id,
            x: t.x,
            y: t.y,
            w: t.w,
            h: t.h,
            content: t.content,
            style: {
                color: t.color,
                size: t.size,
            },
            scene: t.scene, // CRITICAL: Include scene for causal consistency
        }));
        // Build presence view
        const presence = this.buildPresenceView();
        // Build spatial index (stub for now)
        const spatialIndex = { _tree: null };
        // Build view transform
        const view = this.getViewTransform();
        // Build metadata
        const meta = {
            cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES, // Use shared config
            readOnly: this.roomStats?.bytes
                ? this.roomStats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES
                : false,
            bytes: this.roomStats?.bytes,
            expiresAt: this.roomStats?.expiresAt,
        };
        // Create frozen snapshot (in development)
        const snapshot = {
            svKey,
            scene: currentScene,
            strokes: Object.freeze(strokes),
            texts: Object.freeze(texts),
            presence,
            spatialIndex,
            view,
            meta,
            createdAt: Date.now(),
        };
        // CRITICAL: Freeze in development to catch mutations
        if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
            // Deep freeze strokes and texts arrays
            Object.freeze(strokes);
            strokes.forEach((s) => Object.freeze(s));
            Object.freeze(texts);
            texts.forEach((t) => Object.freeze(t));
            // Freeze entire snapshot
            return Object.freeze(snapshot);
        }
        return snapshot;
    }
}
// Singleton Registry
class RoomDocManagerRegistryClass {
    managers = new Map();
    get(roomId) {
        let manager = this.managers.get(roomId);
        if (!manager) {
            // eslint-disable-next-line no-console
            console.log('[Registry] Creating new RoomDocManager for:', roomId);
            manager = new RoomDocManagerImpl(roomId);
            this.managers.set(roomId, manager);
        }
        return manager;
    }
    has(roomId) {
        return this.managers.has(roomId);
    }
    remove(roomId) {
        const manager = this.managers.get(roomId);
        if (manager) {
            // eslint-disable-next-line no-console
            console.log('[Registry] Removing RoomDocManager for:', roomId);
            this.managers.delete(roomId);
        }
    }
    destroyAll() {
        // eslint-disable-next-line no-console
        console.log('[Registry] Destroying all RoomDocManagers');
        this.managers.forEach((manager) => manager.destroy());
        this.managers.clear();
    }
}
// Export singleton instance
export const RoomDocManagerRegistry = new RoomDocManagerRegistryClass();
