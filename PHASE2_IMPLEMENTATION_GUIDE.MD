# Phase 2 Implementation Guide: Steps 2.1 & 2.2

## Overview
This guide provides precise instructions for implementing the first two steps of Phase 2: Core Data Layer & Models.
Follow these instructions exactly to avoid initialization races and ensure proper data flow architecture.

## Prerequisites
- Ensure all Phase 1 setup is complete (monorepo, build pipeline, testing framework)
- Verify all dependencies are installed (yjs@13.6.27, y-websocket@3.x, y-indexeddb@9.x)
- Understand that we're NOT implementing network providers or UI components in this phase
- Ensure packages structure exists: if only a 'shared' folder exists, create proper packages/shared structure first

## Critical Constraints (MUST FOLLOW)
1. **Never allow null snapshots** - Always have an EmptySnapshot available
2. **Store arrays as `number[]` in Yjs** - Never store Float32Array directly
3. **UI isolation** - Components must never import yjs/providers directly
4. **Immutable snapshots** - All snapshot objects must be frozen in development, and must persist last render snapshot in Indexeddb(indexeddb out of scope right now, just a note)
5. **Single Y.Doc per room** - Enforce via singleton registry
6. **Idempotency** - All commands must have idempotencyKey

---

## Step 2.1: Define TypeScript Types and Interfaces

### Location: `/home/issak/dev/avlo/packages/shared/src/`

### Task 2.1.1: Create Core Type Aliases
**File:** `packages/shared/src/types/identifiers.ts`

```typescript
// Type aliases for strong typing and clarity
export type StrokeId = string;     // ULID format
export type TextId = string;       // ULID format  
export type SceneIdx = number;     // 0-based scene index
export type UserId = string;       // format: "deviceULID:tabULID"
export type RoomId = string;       // server-assigned or "local-<ulid>"
```

### Task 2.1.2: Define Stroke and Drawing Types
**File:** `packages/shared/src/types/room.ts`

```typescript
import { StrokeId, TextId, SceneIdx, UserId } from './identifiers';

// Individual stroke point with optional pressure
export interface StrokePoint {
  x: number;
  y: number;
  p?: number; // pressure 0..1, optional
}

// Complete stroke data structure
export interface Stroke {
  id: StrokeId;
  tool: 'pen' | 'highlighter';
  color: string;            // #RRGGBB format
  size: number;             // world units (px at scale=1)
  opacity: number;          // 0..1; highlighter default 0.25
  points: number[];         // CRITICAL: flattened [x0,y0,(p0?), x1,y1,(p1?), ...]
                           // NEVER Float32Array in storage
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY] world units
  scene: SceneIdx;          // assigned at commit time
  createdAt: number;        // ms epoch timestamp
  userId: UserId;           // awareness id at commit
}

// Text block structure
export interface TextBlock {
  id: TextId;
  x: number;                // world units (anchor point)
  y: number;                // world units (anchor point)
  w: number;                // layout box width
  h: number;                // layout box height
  content: string;          // committed once, immutable (max 500 chars)
  color: string;            // #RRGGBB format
  size: number;             // font px at scale=1
  scene: SceneIdx;          // scene index
  createdAt: number;        // ms epoch
  userId: UserId;           // creator id
}

// Code cell for execution
export interface CodeCell {
  lang: 'javascript' | 'python';
  body: string;             // ≤ 200 KB
  version: number;          // increments per commit
}

// Execution output
export interface Output {
  ts: number;               // ms epoch
  text: string;             // ≤ 10 KB per output
}

// Document metadata
export interface Meta {
  scene_ticks: number[];    // append-only scene ticks (excluded from global undo)
  canvas?: {                // doc-level reference size (optional)
    baseW: number;
    baseH: number;
  };
}

// Constants for validation
export const MAX_POINTS_PER_STROKE = 10_000;
export const MAX_TOTAL_STROKES = 5_000;
export const MAX_TEXT_LENGTH = 500;
export const MAX_CODE_BODY_SIZE = 200 * 1024; // 200KB
export const MAX_OUTPUT_SIZE = 10 * 1024;     // 10KB
export const MAX_OUTPUTS_COUNT = 10;
export const MAX_TOTAL_OUTPUT_SIZE = 128 * 1024; // 128KB
```

### Task 2.1.3: Define Awareness Structure
**File:** `packages/shared/src/types/awareness.ts`

```typescript
import { UserId } from './identifiers';

// Ephemeral awareness data - NEVER persisted
export interface Awareness {
  userId: UserId;
  name: string;
  color: string;            // User's cursor/badge color
  cursor?: {                // Optional cursor position
    x: number;              // world coordinates (always)
    y: number;              // world coordinates (always)
  };
  activity: 'idle' | 'drawing' | 'typing';
  seq: number;              // monotonic sequence per-sender
  ts: number;               // send time ms epoch
  aw_v?: number;            // awareness version for evolution
}

// Presence view derived from awareness
export interface PresenceView {
  users: Map<UserId, {
    name: string;
    color: string;
    cursor?: { x: number; y: number };
    activity: string;
    lastSeen: number;
  }>;
  localUserId: UserId;
}
```

### Task 2.1.4: Define Command Types
**File:** `packages/shared/src/types/commands.ts`

```typescript
import { StrokeId, TextId, SceneIdx } from './identifiers';

// All possible commands that can be executed
export type Command =
  | DrawStrokeCommit
  | EraseObjects
  | AddText
  | ClearBoard
  | ExtendTTL
  | CodeUpdate
  | CodeRun;

// Draw stroke command
export interface DrawStrokeCommit {
  type: 'DrawStrokeCommit';
  id: StrokeId;             // Also serves as idempotencyKey
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  points: number[];         // Already simplified, world coordinates
  bbox: [number, number, number, number];
  startedAt: number;
  finishedAt: number;
  scene: SceneIdx;         // Current scene at commit time
}
//CRITICAL NOTE: SCROKES MUST HAVE A SCENE ASSIGNED AT COMMIT TIME

// Erase multiple objects
export interface EraseObjects {
  type: 'EraseObjects';
  ids: (StrokeId | TextId)[];
  idempotencyKey: string;   // Generated ULID
}

// Add text block
export interface AddText {
  type: 'AddText';
  id: TextId;               // Also serves as idempotencyKey
  x: number;
  y: number;
  w: number;
  h: number;
  content: string;
  color: string;
  size: number;
}

// Clear board (append scene tick)
export interface ClearBoard {
  type: 'ClearBoard';
  idempotencyKey: string;   // Format: "scene_<beforeIdx>_<tsBucket>"
}

// Extend room TTL
export interface ExtendTTL {
  type: 'ExtendTTL';
  idempotencyKey: string;   // Format: "ttl_<timestamp>"
}

// Update code cell
export interface CodeUpdate {
  type: 'CodeUpdate';
  lang: 'javascript' | 'python';
  body: string;
  version: number;          // Expected current version
  idempotencyKey: string;
}

// Run code
export interface CodeRun {
  type: 'CodeRun';
  idempotencyKey: string;
}

// Validation results
export interface ValidationResult {
  valid: boolean;
  reason?: 'view_only' | 'read_only' | 'oversize' | 'rate_limited' | 'invalid_data';
  details?: string;
}
```

### Task 2.1.5: Define Snapshot Interfaces
**File:** `packages/shared/src/types/snapshot.ts`

```typescript
import { SceneIdx, StrokeId, TextId } from './identifiers';
import { PresenceView } from './awareness';

// Immutable snapshot - NEVER null
export interface Snapshot {
  svKey: string;            // base64 of Yjs state vector - keys IDB render snapshot
  scene: SceneIdx;          // Current scene index
  strokes: ReadonlyArray<StrokeView>;
  texts: ReadonlyArray<TextView>;
  presence: PresenceView;   // Derived + smoothed presence
  spatialIndex: RBushIndexView; // Read-only spatial index for hit-testing
  view: ViewTransform;      // World-to-canvas transform
  meta: SnapshotMeta;
  createdAt: number;        // ms epoch when snapshot was frozen
}

// Stroke view for rendering
export interface StrokeView {
  id: StrokeId;
  polyline: Float32Array | null;  // Built at RENDER time ONLY from stored number[]
                                   // Will be null in snapshot, created during canvas render
  style: {
    color: string;
    size: number;
    opacity: number;
    tool: 'pen' | 'highlighter';
  };
  bbox: [number, number, number, number];
}

// Text view for rendering
export interface TextView {
  id: TextId;
  x: number;
  y: number;
  w: number;
  h: number;
  content: string;
  style: {
    color: string;
    size: number;
  };
}

// Spatial index view
export interface RBushIndexView {
  // Opaque structure - implementation detail
  // Will be populated by RBush library
  _tree?: any; // RBush internal structure
}

// View transform for coordinate conversion
export interface ViewTransform {
  worldToCanvas: (x: number, y: number) => [number, number];
  canvasToWorld: (x: number, y: number) => [number, number];
  scale: number;            // world px → canvas px
  pan: { x: number; y: number }; // world offset
}

// Snapshot metadata
export interface SnapshotMeta {
  bytes?: number;           // Last persisted compressed size
  cap: number;              // Hard cap (10MB)
  readOnly: boolean;        // True when room is at/above cap
  expiresAt?: number;       // ms epoch TTL expiry
}

// Empty snapshot constant shape
export function createEmptySnapshot(): Snapshot {
  return Object.freeze({
    svKey: 'empty',
    scene: 0,
    strokes: Object.freeze([]),
    texts: Object.freeze([]),
    presence: {
      users: new Map(),
      localUserId: ''
    },
    spatialIndex: { _tree: null },
    view: {
      worldToCanvas: (x: number, y: number) => [x, y],
      canvasToWorld: (x: number, y: number) => [x, y],
      scale: 1,
      pan: { x: 0, y: 0 }
    },
    meta: {
      cap: 10 * 1024 * 1024, // 10MB
      readOnly: false
    },
    createdAt: Date.now()
  });
}
```

### Task 2.1.6: Define Device UI State
**File:** `packages/shared/src/types/device-state.ts`

```typescript
// Toolbar state stored locally
export interface ToolbarState {
  tool: 'pen' | 'highlighter' | 'text' | 'eraser' | 'stamp';
  size: number;
  color: string;
  opacity: number;
  advancedOpen: boolean;
}

// Complete device UI state
export interface DeviceUIState {
  toolbar: ToolbarState;
  collaborationMode: 'server' | 'peer';
  aiPanelOpen: boolean;
  lastVersionSeen: string;  // For update prompts
}

// Storage key constant
export const DEVICE_UI_STORAGE_KEY = 'avlo:v1:ui';
```

### Task 2.1.7: Create Validation Helpers
**File:** `packages/shared/src/types/validation.ts`

```typescript
import { 
  MAX_POINTS_PER_STROKE,
  MAX_TOTAL_STROKES,
  MAX_TEXT_LENGTH,
  MAX_CODE_BODY_SIZE,
  MAX_OUTPUT_SIZE
} from './room';
import { Command } from './commands';

// Type guards
export function isStrokeCommand(cmd: Command): cmd is DrawStrokeCommit {
  return cmd.type === 'DrawStrokeCommit';
}

export function isEraseCommand(cmd: Command): cmd is EraseObjects {
  return cmd.type === 'EraseObjects';
}

export function isTextCommand(cmd: Command): cmd is AddText {
  return cmd.type === 'AddText';
}

// Validation functions
export function validateStrokePoints(points: number[]): boolean {
  if (!points || !Array.isArray(points)) return false;
  if (points.length === 0) return false;
  if (points.length / 2 > MAX_POINTS_PER_STROKE) return false;
  
  // Check all values are finite numbers
  return points.every(p => typeof p === 'number' && isFinite(p));
}

export function validateTextContent(content: string): boolean {
  if (typeof content !== 'string') return false;
  if (content.length === 0) return false;
  if (content.length > MAX_TEXT_LENGTH) return false;
  return true;
}

export function validateCodeBody(body: string): boolean {
  if (typeof body !== 'string') return false;
  if (body.length > MAX_CODE_BODY_SIZE) return false;
  return true;
}

// Size estimation for frame size validation
export function estimateEncodedSize(cmd: Command): number {
  // Rough estimation of JSON-encoded size
  const json = JSON.stringify(cmd);
  return new TextEncoder().encode(json).length;
}

// Frame size limit
export const MAX_FRAME_SIZE = 2 * 1024 * 1024; // 2MB
```

### Task 2.1.8: Update Main Export File
**File:** `packages/shared/src/index.ts`

```typescript
// Re-export all types
export * from './types/identifiers';
export * from './types/room';
export * from './types/awareness';
export * from './types/commands';
export * from './types/snapshot';
export * from './types/device-state';
export * from './types/validation';
```

---

## Step 2.2: Implement RoomDocManager Foundation

### Location: `/home/issak/dev/avlo/client/src/lib/`

### Task 2.2.1: Create RoomDocManager Class
**File:** `client/src/lib/room-doc-manager.ts`

```typescript
import * as Y from 'yjs';
import { 
  createEmptySnapshot  // Regular import, not type import - function needs to be callable
} from '@avlo/shared';
import type {
  RoomId,
  Snapshot,
  PresenceView,
  Command,
  Stroke,
  TextBlock,
  CodeCell,
  Output,
  Meta
} from '@avlo/shared';

// Type for unsubscribe function
type Unsub = () => void;

// Room statistics
interface RoomStats {
  bytes: number;    // Compressed size in bytes
  cap: number;      // Hard cap (10MB)
}

// Manager interface - public API
export interface IRoomDocManager {
  readonly currentSnapshot: Snapshot;
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub;
  subscribePresence(cb: (p: PresenceView) => void): Unsub;
  subscribeRoomStats(cb: (s: RoomStats | null) => void): Unsub;
  write(cmd: Command): void;
  extendTTL(): void;
  destroy(): void;
}

// Private implementation
class RoomDocManagerImpl implements IRoomDocManager {
  // Core properties
  private readonly roomId: RoomId;
  private readonly ydoc: Y.Doc;
  
  // Y.js structures (initialized in constructor)
  private readonly yStrokes: Y.Array<Stroke>;
  private readonly yTexts: Y.Array<TextBlock>;
  private readonly yCode: Y.Map<any>;
  private readonly yOutputs: Y.Array<Output>;
  private readonly yMeta: Y.Map<any>;
  
  // Providers (will be null initially, added in later phases)
  private indexeddbProvider: any = null;
  private websocketProvider: any = null;
  private webrtcProvider: any = null;
  
  // Current state
  private _currentSnapshot: Snapshot;
  private lastStateVector: Uint8Array | null = null;
  
  // Subscription management
  private snapshotSubscribers = new Set<(snap: Snapshot) => void>();
  private presenceSubscribers = new Set<(p: PresenceView) => void>();
  private statsSubscribers = new Set<(s: RoomStats | null) => void>();
  
  // Publishing state
  private publishRAF: number | null = null;
  private pendingPublish = false;
  private lastPublishTime = 0;
  private isTabHidden = false;
  
  // Batch window management
  private batchWindowMs = 8; // Start with 8-16ms window
  private readonly MIN_BATCH_WINDOW = 8;
  private readonly MAX_BATCH_WINDOW = 32;
  
  constructor(roomId: RoomId) {
    this.roomId = roomId;
    
    // CRITICAL: Create Y.Doc with guid matching roomId
    this.ydoc = new Y.Doc({ guid: roomId });
    
    // Initialize Y.js structures
    this.yStrokes = this.ydoc.getArray<Stroke>('strokes');
    this.yTexts = this.ydoc.getArray<TextBlock>('texts');
    this.yCode = this.ydoc.getMap('code');
    this.yOutputs = this.ydoc.getArray<Output>('outputs');
    this.yMeta = this.ydoc.getMap('meta');
    
    // Initialize meta if not present
    if (!this.yMeta.has('scene_ticks')) {
      this.yMeta.set('scene_ticks', []);
    }
    
    // CRITICAL: Initialize with EmptySnapshot (NEVER null)
    this._currentSnapshot = createEmptySnapshot();
    
    // Set up observers
    this.setupObservers();
    
    // Set up visibility change detection
    this.setupVisibilityHandling();
    
    // Start publish loop
    this.startPublishLoop();
  }
  
  // Public getters
  get currentSnapshot(): Snapshot {
    return this._currentSnapshot;
  }
  
  // Subscription methods
  subscribeSnapshot(cb: (snap: Snapshot) => void): Unsub {
    this.snapshotSubscribers.add(cb);
    // Immediately call with current snapshot
    cb(this._currentSnapshot);
    
    return () => {
      this.snapshotSubscribers.delete(cb);
    };
  }
  
  subscribePresence(cb: (p: PresenceView) => void): Unsub {
    this.presenceSubscribers.add(cb);
    // Immediately call with current presence
    cb(this._currentSnapshot.presence);
    
    return () => {
      this.presenceSubscribers.delete(cb);
    };
  }
  
  subscribeRoomStats(cb: (s: RoomStats | null) => void): Unsub {
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
  write(cmd: Command): void {
    console.log('[RoomDocManager] Write command:', cmd.type);
    // Will be connected to WriteQueue/CommandBus in step 2.5
    this.requestPublish();
  }
  
  // Extend TTL (stub)
  extendTTL(): void {
    console.log('[RoomDocManager] Extending TTL');
    // Will be implemented with rate limiting
  }
  
  // Lifecycle
  destroy(): void {
    console.log('[RoomDocManager] Destroying');
    
    // Cancel any pending publish
    if (this.publishRAF !== null) {
      cancelAnimationFrame(this.publishRAF);
      this.publishRAF = null;
    }
    
    // Clear subscribers
    this.snapshotSubscribers.clear();
    this.presenceSubscribers.clear();
    this.statsSubscribers.clear();
    
    // Destroy providers (when added)
    // this.indexeddbProvider?.destroy();
    // this.websocketProvider?.destroy();
    // this.webrtcProvider?.destroy();
    
    // Destroy Y.Doc
    this.ydoc.destroy();
    
    // Remove from registry
    RoomDocManagerRegistry.remove(this.roomId);
  }
  
  // Private: Set up Y.js observers
  private setupObservers(): void {
    // Observe document changes
    this.ydoc.on('update', (update: Uint8Array, origin: any) => {
      console.log('[RoomDocManager] Y.Doc updated');
      this.requestPublish();
    });
    
    // Will add more specific observers as needed
  }
  
  // Private: Handle tab visibility
  private setupVisibilityHandling(): void {
    document.addEventListener('visibilitychange', () => {
      const wasHidden = this.isTabHidden;
      this.isTabHidden = document.hidden;
      console.log('[RoomDocManager] Tab visibility:', this.isTabHidden ? 'hidden' : 'visible');
      
      // When switching from visible to hidden, cancel RAF and use setTimeout
      if (!wasHidden && this.isTabHidden && this.publishRAF !== null) {
        cancelAnimationFrame(this.publishRAF);
        this.publishRAF = null;
        // If we have pending publish, reschedule with setTimeout
        if (this.pendingPublish) {
          const delay = Math.min(125, this.batchWindowMs); // Cap at 8 FPS
          setTimeout(() => this.publish(), delay);
        }
      }
      // When switching from hidden to visible, re-request publish if pending
      else if (wasHidden && !this.isTabHidden && this.pendingPublish) {
        this.requestPublish();
      }
    });
  }
  
  // Private: Start the publish loop
  private startPublishLoop(): void {
    // Publish loop will be called via requestAnimationFrame
    // when updates occur
  }
  
  // Private: Request a publish on next frame
  private requestPublish(): void {
    if (this.pendingPublish) return;
    
    this.pendingPublish = true;
    
    // Cancel any existing scheduled publish
    if (this.publishRAF !== null) {
      cancelAnimationFrame(this.publishRAF);
      this.publishRAF = null;
    }
    
    // Use appropriate timing based on tab visibility
    if (this.isTabHidden) {
      // Use setTimeout when hidden (target ~8 FPS max)
      // Use batch window timing, but cap at 125ms (8 FPS)
      const delay = Math.min(125, this.batchWindowMs);
      setTimeout(() => this.publish(), delay);
    } else {
      // Use requestAnimationFrame when visible (up to 60 FPS)
      this.publishRAF = requestAnimationFrame(() => this.publish());
    }
  }
  
  // Private: Build and publish snapshot
  private publish(): void {
    const startTime = performance.now();
    this.pendingPublish = false;
    this.publishRAF = null;
    
    // Build new snapshot
    const snapshot = this.buildSnapshot();
    
    // Check if snapshot actually changed (by comparing svKey)
    if (snapshot.svKey === this._currentSnapshot.svKey) {
      // No actual changes, skip publish
      return;
    }
    
    // Update current snapshot
    this._currentSnapshot = snapshot;
    
    // Notify all subscribers
    this.snapshotSubscribers.forEach(cb => {
      try {
        cb(snapshot);
      } catch (err) {
        console.error('[RoomDocManager] Snapshot subscriber error:', err);
      }
    });
    
    // Notify presence subscribers if presence changed
    this.presenceSubscribers.forEach(cb => {
      try {
        cb(snapshot.presence);
      } catch (err) {
        console.error('[RoomDocManager] Presence subscriber error:', err);
      }
    });
    
    // Track publish time for adaptive batching
    const publishTime = performance.now() - startTime;
    this.lastPublishTime = publishTime;
    
    // Adjust batch window based on performance
    if (publishTime > 8) {
      // Expand window if publish is taking too long
      this.batchWindowMs = Math.min(this.MAX_BATCH_WINDOW, this.batchWindowMs * 1.5);
    } else if (publishTime < 4 && this.batchWindowMs > this.MIN_BATCH_WINDOW) {
      // Shrink window if we have headroom
      this.batchWindowMs = Math.max(this.MIN_BATCH_WINDOW, this.batchWindowMs * 0.9);
    }
  }
  
  // Private: Build immutable snapshot from Y.Doc
  private buildSnapshot(): Snapshot {
    // Get current state vector for svKey
    const stateVector = Y.encodeStateVector(this.ydoc);
    const svKey = btoa(String.fromCharCode(...stateVector));
    
    // Get current scene
    const sceneTicks = this.yMeta.get('scene_ticks') as number[] || [];
    const currentScene = sceneTicks.length;
    
    // Build stroke views (filter by current scene)
    const strokes = this.yStrokes.toArray()
      .filter(s => s.scene === currentScene)
      .map(s => ({
        id: s.id,
        // CRITICAL: Float32Array MUST be created at render time only, never in snapshot
        polyline: null as any, // Will be created at render time from s.points
        style: {
          color: s.color,
          size: s.size,
          opacity: s.opacity,
          tool: s.tool
        },
        bbox: s.bbox
      }));
    
    // Build text views (filter by current scene)
    const texts = this.yTexts.toArray()
      .filter(t => t.scene === currentScene)
      .map(t => ({
        id: t.id,
        x: t.x,
        y: t.y,
        w: t.w,
        h: t.h,
        content: t.content,
        style: {
          color: t.color,
          size: t.size
        }
      }));
    
    // Build presence view (stub for now)
    const presence: PresenceView = {
      users: new Map(),
      localUserId: ''
    };
    
    // Build spatial index (stub for now)
    const spatialIndex = { _tree: null };
    
    // Build view transform (identity for now)
    const view: ViewTransform = {
      worldToCanvas: (x: number, y: number) => [x, y],
      canvasToWorld: (x: number, y: number) => [x, y],
      scale: 1,
      pan: { x: 0, y: 0 }
    };
    
    // Build metadata
    const meta: SnapshotMeta = {
      cap: 10 * 1024 * 1024, // 10MB
      readOnly: false,
      bytes: undefined,
      expiresAt: undefined
    };
    
    // Create frozen snapshot (in development)
    const snapshot: Snapshot = {
      svKey,
      scene: currentScene,
      strokes: Object.freeze(strokes) as ReadonlyArray<StrokeView>,
      texts: Object.freeze(texts) as ReadonlyArray<TextView>,
      presence,
      spatialIndex,
      view,
      meta,
      createdAt: Date.now()
    };
    
    // Freeze entire snapshot in development
    // NEEDS BUILT TIME REPLACEMENT FOR BROWSER
    if (process.env.NODE_ENV === 'development') {
      return Object.freeze(snapshot);
    }
    
    return snapshot;
  }
}

// Singleton Registry
class RoomDocManagerRegistryClass {
  private managers = new Map<RoomId, IRoomDocManager>();
  
  get(roomId: RoomId): IRoomDocManager {
    let manager = this.managers.get(roomId);
    
    if (!manager) {
      console.log('[Registry] Creating new RoomDocManager for:', roomId);
      manager = new RoomDocManagerImpl(roomId);
      this.managers.set(roomId, manager);
    }
    
    return manager;
  }
  
  has(roomId: RoomId): boolean {
    return this.managers.has(roomId);
  }
  
  remove(roomId: RoomId): void {
    const manager = this.managers.get(roomId);
    if (manager) {
      console.log('[Registry] Removing RoomDocManager for:', roomId);
      this.managers.delete(roomId);
    }
  }
  
  destroyAll(): void {
    console.log('[Registry] Destroying all RoomDocManagers');
    this.managers.forEach(manager => manager.destroy());
    this.managers.clear();
  }
}

// Export singleton instance
export const RoomDocManagerRegistry = new RoomDocManagerRegistryClass();

// Export manager type
export type RoomDocManager = IRoomDocManager;
```

### Task 2.2.2: Create React Hooks
**File:** `client/src/hooks/use-room-doc.ts`

```typescript
import { useEffect, useRef } from 'react';
import { RoomId } from '@avlo/shared';
import { RoomDocManagerRegistry, RoomDocManager } from '../lib/room-doc-manager';

/**
 * Internal hook to get or create a RoomDocManager instance
 * NOTE: This is an internal hook. UI components should use
 * useSnapshot, usePresence, or useRoomStats instead to maintain
 * a narrow, hook-based surface as per the architecture.
 * @internal
 */
export function useRoomDoc(roomId: RoomId): RoomDocManager {
  const managerRef = useRef<RoomDocManager>();
  
  if (!managerRef.current) {
    managerRef.current = RoomDocManagerRegistry.get(roomId);
  }
  
  useEffect(() => {
    // Manager lifecycle is handled by the registry
    // Components don't destroy managers directly
    return () => {
      // Cleanup if needed in future
    };
  }, [roomId]);
  
  return managerRef.current;
}
```

**File:** `client/src/hooks/use-room-snapshot.ts` 

```typescript
import { useEffect, useState } from 'react';
import { RoomId, Snapshot } from '@avlo/shared';
import { useRoomDoc } from './use-room-doc';

/**
 * Hook to subscribe to room snapshot updates
 * Returns the current immutable snapshot
 * UI components should use this instead of accessing the manager directly
 */
export function useRoomSnapshot(roomId: RoomId): Snapshot {
  const roomDoc = useRoomDoc(roomId);
  const [snapshot, setSnapshot] = useState<Snapshot>(roomDoc.currentSnapshot);
  
  useEffect(() => {
    // Subscribe to snapshot updates
    const unsub = roomDoc.subscribeSnapshot((newSnapshot) => {
      setSnapshot(newSnapshot);
    });
    
    return unsub;
  }, [roomDoc]);
  
  return snapshot;
}
```

**File:** `client/src/hooks/use-snapshot.ts`

```typescript
import { useEffect, useState } from 'react';
import { RoomId, Snapshot } from '@avlo/shared';
import { useRoomDoc } from './use-room-doc';

/**
 * Hook to subscribe to snapshot updates
 * Returns the current immutable snapshot
 */
export function useSnapshot(roomId: RoomId): Snapshot {
  const roomDoc = useRoomDoc(roomId);
  const [snapshot, setSnapshot] = useState<Snapshot>(roomDoc.currentSnapshot);
  
  useEffect(() => {
    // Subscribe to snapshot updates
    const unsub = roomDoc.subscribeSnapshot((newSnapshot) => {
      setSnapshot(newSnapshot);
    });
    
    return unsub;
  }, [roomDoc]);
  
  return snapshot;
}
```

**File:** `client/src/hooks/use-presence.ts`

```typescript
import { useEffect, useState } from 'react';
import { RoomId, PresenceView } from '@avlo/shared';
import { useRoomDoc } from './use-room-doc';

/**
 * Hook to subscribe to presence updates
 * Returns the current presence view
 */
export function usePresence(roomId: RoomId): PresenceView {
  const roomDoc = useRoomDoc(roomId);
  const [presence, setPresence] = useState<PresenceView>(roomDoc.currentSnapshot.presence);
  
  useEffect(() => {
    // Subscribe to presence updates
    const unsub = roomDoc.subscribePresence((newPresence) => {
      setPresence(newPresence);
    });
    
    return unsub;
  }, [roomDoc]);
  
  return presence;
}
```

**File:** `client/src/hooks/use-room-stats.ts`

```typescript
import { useEffect, useState } from 'react';
import { RoomId } from '@avlo/shared';
import { useRoomDoc } from './use-room-doc';

interface RoomStats {
  bytes: number;
  cap: number;
}

/**
 * Hook to subscribe to room statistics updates
 * Returns the current room stats (size/cap) or null
 */
export function useRoomStats(roomId: RoomId): RoomStats | null {
  const roomDoc = useRoomDoc(roomId);
  const [stats, setStats] = useState<RoomStats | null>(null);
  
  useEffect(() => {
    // Subscribe to room stats updates
    const unsub = roomDoc.subscribeRoomStats((newStats) => {
      setStats(newStats);
    });
    
    return unsub;
  }, [roomDoc]);
  
  return stats;
}
```

---

## Testing Requirements

### Unit Tests to Create

1. **Type validation tests** (`packages/shared/src/types/__tests__/validation.test.ts`)
   - Test all validation functions
   - Test type guards
   - Test size estimation

2. **RoomDocManager tests** (`client/src/lib/__tests__/room-doc-manager.test.ts`)
   - Test singleton behavior
   - Test EmptySnapshot initialization
   - Test subscription/unsubscription
   - Test snapshot building
   - Test batch window adaptation
   - Test visibility handling

3. **Hook tests** (`client/src/hooks/__tests__/`)
   - Test useRoomDoc singleton behavior (internal hook)
   - Test useRoomSnapshot updates
   - Test useSnapshot updates
   - Test usePresence updates
   - Test useRoomStats updates

---
# Phase 2 Critical Constraints & Race Condition Prevention

## Initialization Race Conditions to Prevent

### 1. EmptySnapshot Race
**Problem:** UI tries to render before snapshot exists
**Solution:** 
- `_currentSnapshot` is initialized synchronously in constructor with `createEmptySnapshot()`
- Never allow `currentSnapshot` getter to return null/undefined
- Subscribers receive current snapshot immediately upon subscription

### 2. Y.Doc GUID Race
**Problem:** Y.Doc created with wrong/temporary guid, then changed
**Solution:**
- Y.Doc MUST be created with `{ guid: roomId }` in constructor
- GUID is immutable after creation
- Never attempt to change Y.Doc guid

### 3. Provider Attachment Race
**Problem:** Providers attached before Y.Doc structures initialized
**Solution (for later phases):**
- Initialize all Y.structures (arrays, maps) BEFORE attaching any providers
- Order: Y.Doc → Y.structures → IDB provider → WS provider → WebRTC provider
- Each provider attachment has its own gate (G_IDB_READY, G_WS_CONNECTED, etc.)

### 4. Subscription Timing Race
**Problem:** Component subscribes but misses initial state
**Solution:**
- All subscription methods call callback immediately with current state
- Pattern: `subscribers.add(cb); cb(currentState); return unsub;`

### 5. Multi-Tab Race
**Problem:** Multiple tabs create managers for same room
**Solution:**
- Singleton registry ensures one manager per room per tab
- Later: BroadcastChannel for cross-tab coordination (Phase 4)

## Data Flow Architecture

### Authoritative Write Path
```
UI Event
    ↓
Command (with idempotencyKey)
    ↓
WriteQueue.validate() [Phase 2.5]
    - Check: not read-only (size < 10MB)
    - Check: not mobile (view-only)
    - Check: frame size < 2MB
    - Check: not duplicate (idempotency)
    ↓
CommandBus.execute() [Phase 2.5]
    - Single yjs.transact() per command
    - Apply to Y.structures
    ↓
Y.Doc 'update' event
    ↓
RoomDocManager.requestPublish()
    - Batch within 8-32ms window
    - Respect RAF timing
    ↓
RoomDocManager.buildSnapshot()
    - Generate svKey from state vector
    - Filter by current scene
    - Create immutable arrays
    - Freeze in development
    ↓
Notify subscribers
    - Snapshot subscribers
    - Presence subscribers
    - Stats subscribers
```

### Read Path (Rendering)
```
Subscriber (React component)
    ↓
useSnapshot(roomId) hook
    ↓
RoomDocManagerRegistry.get(roomId)
    - Returns existing or creates new
    ↓
manager.subscribeSnapshot(callback)
    - Immediate callback with current
    - Updates on changes
    ↓
Immutable Snapshot
    - Never null (EmptySnapshot minimum)
    - Frozen arrays and objects
    - svKey for stability tracking
    ↓
Render from snapshot ONLY
    - Never read Y.Doc directly
    - Convert number[] → Float32Array at render
```

## Critical Data Constraints

### Storage Format Rules
```typescript
// In Yjs Document (Storage)
points: number[]              // ✓ Correct - plain array
points: Float32Array         // ✗ Wrong - breaks serialization

// In Snapshot (Building)
polyline: null as any        // ✓ Correct - placeholder until render
polyline: new Float32Array(0) // ✗ Wrong - never create in snapshot

// In Canvas Render (Phase 3)
polyline: new Float32Array(stroke.points) // ✓ Created at render time only
```

### Snapshot Immutability Rules
```typescript
// Building snapshot
const strokes = array.map(...);           // Create new array
Object.freeze(strokes);                    // Freeze array
return Object.freeze({ strokes, ... });   // Freeze snapshot

// Never do this:
snapshot.strokes.push(newStroke);         // ✗ Mutation!
snapshot.scene = 5;                       // ✗ Mutation!
```

### Command Idempotency Rules
```typescript
// Every command MUST have idempotencyKey
interface DrawStrokeCommit {
  type: 'DrawStrokeCommit';
  id: StrokeId;            // This IS the idempotencyKey
  // ...
}

interface ClearBoard {
  type: 'ClearBoard';
  idempotencyKey: string;  // Format: "scene_<idx>_<bucket>"
}

// WriteQueue tracks processed keys
processedKeys = new Set<string>();
if (processedKeys.has(cmd.idempotencyKey)) {
  return; // Skip duplicate
}
```

## Performance Constraints

### Batch Window Management
```typescript
// Adaptive batching based on publish time
if (publishTime > 8ms) {
  batchWindow = min(32ms, batchWindow * 1.5);
} else if (publishTime < 4ms) {
  batchWindow = max(8ms, batchWindow * 0.9);
}

// Never exceed 32ms to maintain responsiveness
MAX_BATCH_WINDOW = 32ms
```

### RAF and Visibility
```typescript
// Visible tab: 60 FPS max
if (!document.hidden) {
  requestAnimationFrame(publish);
}

// Hidden tab: 8 FPS max
if (document.hidden) {
  setTimeout(publish, 125); // 8 FPS
}
```

### Memory Management
```typescript
// Cleanup on destroy
destroy() {
  cancelAnimationFrame(this.publishRAF);
  this.subscribers.clear();
  this.ydoc.destroy();
  Registry.remove(this.roomId);
}
```

## Validation Guards

### Size Limits (from OVERVIEW.MD)
```typescript
MAX_POINTS_PER_STROKE = 10_000
MAX_TOTAL_STROKES = 5_000
MAX_TEXT_LENGTH = 500
MAX_CODE_BODY_SIZE = 200KB
MAX_FRAME_SIZE = 2MB
ROOM_SIZE_WARN = 8MB
ROOM_SIZE_CAP = 10MB  // Becomes read-only
```

### Rate Limits
```typescript
// ClearBoard: 1 per 15 seconds (server)
// ExtendTTL: 1 per 10 minutes (client)
// Room creation: 10 per hour per IP
// Rename: 5 per minute
```

## Common Anti-Patterns to Avoid

### 1. Direct Y.Doc Access
```typescript
// ✗ WRONG - Component accessing Y.Doc
function Component() {
  const ydoc = new Y.Doc();
  const strokes = ydoc.getArray('strokes');
}

// ✓ CORRECT - Use hooks and manager
function Component() {
  const snapshot = useSnapshot(roomId);
  const strokes = snapshot.strokes;
}
```

### 2. Mutable Updates
```typescript
// ✗ WRONG - Mutating snapshot
const snapshot = manager.currentSnapshot;
snapshot.strokes.push(newStroke);

// ✓ CORRECT - Use commands
manager.write({
  type: 'DrawStrokeCommit',
  id: generateId(),
  // ...
});
```

### 3. Synchronous Heavy Work
```typescript
// ✗ WRONG - Blocking publish
publish() {
  for (let i = 0; i < 100000; i++) {
    // Heavy computation
  }
}

// ✓ CORRECT - Yield if needed
publish() {
  if (performance.now() - start > 8) {
    // Defer rest to next frame
    requestAnimationFrame(() => continuePublish());
  }
}
```

### 4. Missing Cleanup
```typescript
// ✗ WRONG - Leak
useEffect(() => {
  const unsub = manager.subscribe(callback);
  // Missing return
});

// ✓ CORRECT - Cleanup
useEffect(() => {
  const unsub = manager.subscribe(callback);
  return unsub; // Cleanup on unmount
});
```

## Testing for Race Conditions

### Test 1: Rapid Subscribe/Unsubscribe
```typescript
for (let i = 0; i < 100; i++) {
  const unsub = manager.subscribeSnapshot(() => {});
  unsub();
}
// Should not crash or leak
```

### Test 2: Destroy During Update
```typescript
manager.write(command);
manager.destroy();
// Should cleanup without errors
```

### Test 3: Multiple Simultaneous Subscribes
```typescript
const unsubs = [];
for (let i = 0; i < 10; i++) {
  unsubs.push(manager.subscribeSnapshot(() => {}));
}
// All should receive updates
```

### Test 4: Tab Visibility During Update
```typescript
Object.defineProperty(document, 'hidden', { value: true });
manager.write(command);
// Should use setTimeout, not RAF
```

## Summary: Key Invariants

1. **Snapshot is NEVER null** - EmptySnapshot exists from construction
2. **Y.Doc guid === roomId** - Set once, never changed
3. **Arrays are number[] in storage** - Float32Array only at render
4. **Snapshots are immutable** - Frozen in development
5. **One manager per room** - Singleton registry enforced
6. **All commands have idempotencyKey** - Duplicates rejected
7. **Subscribers called immediately** - No missed initial state
8. **Cleanup is complete** - No leaks on destroy
9. **Performance is bounded** - Max 32ms batch, 60 FPS
10. **UI never imports Yjs** - Only through manager/hooks

## Verification Checklist

### Before Proceeding to Step 2.3:

- [ ] All TypeScript types compile without errors
- [ ] EmptySnapshot is never null
- [ ] Y.Doc guid matches roomId exactly
- [ ] All arrays stored as number[] (never Float32Array)
- [ ] Snapshots are frozen in development
- [ ] Singleton registry prevents duplicate managers
- [ ] Subscription callbacks work correctly
- [ ] Batch window adapts to performance
- [ ] Tab visibility affects publish rate
- [ ] All constants match OVERVIEW.MD specifications
- [ ] ESLint passes (especially no-restricted-imports)
- [ ] Unit tests pass

---

## Common Pitfalls to Avoid

1. **Never store Float32Array in Yjs** - Always use number[] and convert at render time
2. **Never allow null snapshots** - Always have EmptySnapshot ready
3. **Never mutate snapshot objects** - They must be immutable
4. **Never import yjs in UI components** - Only through RoomDocManager
5. **Never create multiple Y.Docs for same room** - Use singleton registry
6. **Never skip idempotencyKey** - Every command must have one
7. **Never ignore performance** - Monitor batch window and publish timing
8. **Never forget to freeze** - Snapshots must be frozen in development

---

## Next Steps

After completing 2.1 and 2.2:
- Step 2.3: Set Up Yjs Document Structure
- Step 2.4: Implement Snapshot Publishing System  
- Step 2.5: Create WriteQueue and CommandBus

These foundation steps are critical. Take time to verify everything works correctly before proceeding.