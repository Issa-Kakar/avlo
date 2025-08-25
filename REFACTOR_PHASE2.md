# Phase 2 Comprehensive Refactoring Instructions

## Executive Summary

The Avlo codebase has excellent TypeScript types and shared configuration (Phase 2.1 ✅) but suffers from severe over-engineering in the data layer implementation (Phase 2.2-2.4). The current implementation uses enterprise-scale patterns (WriteQueue, CommandBus, distributed systems primitives) for a system designed for **15 concurrent users maximum**. This document provides pragmatic, context-aware instructions to refactor the codebase to match the OVERVIEW.MD specification while preserving valuable patterns.

## Current State Analysis

### What's Working Well (Keep These)
1. **Type System**: All types in `/packages/shared/src/types/` are correctly implemented
2. **Shared Configuration**: Excellent centralized config with environment overrides
3. **Monorepo Structure**: Clean workspace organization with path aliases
4. **Memory-Safe Testing**: Vitest setup with proper memory management
5. **Helper Utilities**: Ring buffer, timing abstractions, size estimator (keep but simplify usage)
6. **React Hooks**: Clean hook architecture already in place

### Critical Problems to Fix

#### 0. Type Location Issue
**RoomStats Type**: Currently defined in client code but should be in `/packages/shared/src/types/` for proper sharing across workspaces.

#### 1. Over-Engineered Write Pattern (592+ lines vs ~50 needed)
**Current**: 
```typescript
UI → write(cmd) → WriteQueue.validate() → enqueue() → 
CommandBus.processBatch() → timer → applyCommand() → yjs.transact()
```
**Should Be**:
```typescript
UI → mutate(fn) → [minimal guards] → yjs.transact(fn)
```

#### 2. Complex Timer-Driven Publishing
**Current**: `setInterval(20ms) → onBatchTimerTick() → scheduleRaf() → maybePublish() → publish()`
**Should Be**: `RAF → if(dirty) publish() → schedule next RAF`

#### 3. Scene Capture Violation
**Current**: Scene captured at pointer-down (SceneCapture class)
**Should Be**: Scene assigned at commit time using `currentScene`

#### 4. Missing Critical Dependencies
- `zustand@^5.0.0` - Device UI state management
- `@tanstack/react-query@^5.0.0` - Server state (metadata, lists)
- `zod@^4` - Boundary validation

#### 5. Build Artifacts in Source
- 16 `.js` files in `/client/src/lib/` and `/client/src/hooks/`
- Not in `.gitignore`
- Creates confusion and potential merge conflicts

## Refactoring Instructions

### Step 1: Install Missing Dependencies
```bash
# Navigate to client workspace
cd client

# Install missing packages
npm install zustand@^5.0.0 @tanstack/react-query@^5.0.0 zod@^4

# Verify installation
npm ls zustand @tanstack/react-query zod
```

### Step 2: Clean Build Artifacts

#### 2.1 Update .gitignore
Add the following lines to `.gitignore`:
```gitignore
# Compiled JavaScript in source directories
client/src/**/*.js
!client/src/**/*.config.js
packages/*/src/**/*.js
```

#### 2.2 Remove Existing JS Files
```bash
# Remove all .js files from src directories
find client/src -name "*.js" -not -name "*.config.js" -delete
find packages/shared/src -name "*.js" -delete

# Verify removal
find client/src -name "*.js" | grep -v config
```

### Step 3: Replace WriteQueue/CommandBus with Simple Mutate

#### 3.1 Remove Over-Engineered Files
Delete these files completely:
- `/client/src/lib/write-queue.ts` (248 lines)
- `/client/src/lib/command-bus.ts` (344 lines)
- `/client/src/lib/scene-capture.ts` (92 lines)
- `/client/src/lib/scene-capture-integration.ts` (if exists)

#### 3.2 Implement Simple Mutate Pattern

**CRITICAL: Never Cache Y References Rule**
The following implementation follows the fundamental architecture rule: NO cached Y references as class fields. All Y.Doc access must traverse from root on every operation. This prevents stale references and ensures consistency.

In `/client/src/lib/room-doc-manager.ts`, replace the write method:

```typescript
// REMOVE: These imports
import { WriteQueue } from './write-queue';
import { CommandBus } from './command-bus';
import { SceneCapture } from './scene-capture';

// REMOVE: These properties
private writeQueue: WriteQueue | null = null;
private commandBus: CommandBus | null = null;

// ADD: Simple mutate method
mutate(fn: (ydoc: Y.Doc) => void): void {
  // Minimal guards (same as spec)
  
  // 1. Check room read-only (≥15MB)
  if (this.roomStats && this.roomStats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
    console.warn('[RoomDocManager] Room is read-only (size limit exceeded)');
    return;
  }
  
  // 2. Check mobile view-only
  if (this.isMobileDevice()) {
    console.warn('[RoomDocManager] Mobile devices are view-only');
    return;
  }
  
  // 3. Check frame size (if we have a pending update estimate)
  // Note: This is a simplified check - actual implementation would estimate
  // the size of the operation about to be performed
  const estimatedSize = this.sizeEstimator.getCurrentEstimate();
  if (estimatedSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) {
    console.warn('[RoomDocManager] Operation too large (frame size limit)');
    return;
  }
  
  // Execute in single transaction with user origin
  this.ydoc.transact(() => {
    fn(this.ydoc);
  }, this.userId); // Origin for undo/redo tracking
  
  // Mark dirty for publishing
  this.publishState.isDirty = true;
}

// ADD: Helper for mobile detection
private isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}
```

### Step 4: Simplify RAF Publishing

#### 4.1 Remove Timer-Based System

Replace the complex timer system with simple RAF loop:

```typescript
// REMOVE: Timer-based batch system
private startBatchTimer(): void { /* DELETE THIS */ }
private onBatchTimerTick(): void { /* DELETE THIS */ }

// ADD: Simple RAF loop
private startPublishLoop(): void {
  const rafLoop = () => {
    // Publish if Y.Doc changed OR presence changed
    if (this.publishState.isDirty || this.publishState.presenceDirty) {
      const startTime = performance.now();
      
      // Build snapshot
      const newSnapshot = this.buildSnapshot();
      
      // Optional optimization: Skip publish if svKey unchanged and no presence update
      const svKeyChanged = newSnapshot.svKey !== this._currentSnapshot.svKey;
      if (svKeyChanged || this.publishState.presenceDirty) {
        this.publishSnapshot(newSnapshot);
      }
      
      // Clear both dirty flags
      this.publishState.isDirty = false;
      this.publishState.presenceDirty = false;
      
      // Track timing for metrics
      this.publishState.lastPublishTime = performance.now();
      this.publishState.publishCostMs = performance.now() - startTime;
    }
    
    // Continue loop if not destroyed
    if (!this.destroyed) {
      this.publishState.rafId = requestAnimationFrame(rafLoop);
    }
  };
  
  // Start the loop
  this.publishState.rafId = requestAnimationFrame(rafLoop);
}

// SIMPLIFY: Y.Doc update handler
private handleYDocUpdate = (update: Uint8Array, origin: unknown): void => {
  // Just mark dirty - RAF will handle publishing
  this.publishState.isDirty = true;
  
  // Store update for metrics (keep ring buffer, it's useful)
  if (this.publishState.pendingUpdates) {
    this.publishState.pendingUpdates.push({
      update,
      origin,
      time: this.clock.now()
    });
  }
  
  // Update size estimate (keep this, it's needed for guards)
  const deltaBytes = update.byteLength;
  this.sizeEstimator.observeDelta(deltaBytes);
};
```

### Step 5: Fix Scene Assignment

Scene must be assigned at commit time, not at interaction start:

```typescript
// Example: Adding a stroke
mutate((ydoc) => {
  const root = ydoc.getMap('root');
  const strokes = root.get('strokes') as Y.Array<Stroke>;
  
  // Get CURRENT scene at commit time
  const sceneTicks = (root.get('meta') as Y.Map<any>).get('scene_ticks') as Y.Array<number>;
  const currentScene = sceneTicks.length; // This is the current scene NOW
  
  // Create stroke with current scene
  const stroke: Stroke = {
    id: generateULID(),
    tool: 'pen',
    color: '#000000',
    size: 2,
    opacity: 1,
    points: [...], // Flattened points
    bbox: [...],   // Computed bbox
    scene: currentScene, // Assigned at commit time!
    createdAt: Date.now(),
    userId: this.userId,
  };
  
  strokes.push([stroke]);
});
```

### Step 6: Move RoomStats Type to Shared Package

Create `/packages/shared/src/types/room-stats.ts`:

```typescript
export interface RoomStats {
  bytes: number;      // Compressed size in bytes
  cap: number;        // Capacity limit (15MB)
}
```

Then export it from `/packages/shared/src/types/index.ts`:

```typescript
export * from './room-stats';
```

### Step 7: Implement Presence Features

#### 6.1 Add Proper Presence Building

Replace the stub with actual implementation:

```typescript
private buildPresenceView(): PresenceView {
  const users = new Map<string, UserPresence>();
  
  // For now, return proper structure even if awareness not connected
  // This will be populated in Phase 8 when awareness is integrated
  if (this.awareness) {
    this.awareness.getStates().forEach((state, clientId) => {
      if (state.userId && state.cursor) {
        users.set(clientId.toString(), {
          userId: state.userId,
          name: state.name || 'Anonymous',
          color: state.color || '#000000',
          cursor: state.cursor,
          activity: state.activity || 'idle',
        });
      }
    });
  }
  
  return {
    users,
    localUserId: this.userId,
  };
}
```

#### 6.2 Add 30Hz Throttling

```typescript
// ADD: Import throttle utility
import { throttle } from './utils/throttle';

// ADD: Throttled presence updates
private updatePresence = throttle(() => {
  const presence = this.buildPresenceView();
  this.presenceSubscribers.forEach(cb => cb(presence));
  
  // Mark presence dirty to trigger snapshot publish
  this.publishState.presenceDirty = true;
}, 1000 / 30); // 33ms = ~30Hz

// Call updatePresence when awareness changes (Phase 8)
```

### Step 8: Add ESLint Restrictions for UI Isolation

Update `.eslintrc.cjs` in the client workspace to enforce UI isolation from Yjs:

```javascript
module.exports = {
  // ... existing config
  rules: {
    // ... existing rules
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'yjs',
            message: 'UI components must not import Yjs directly. Use RoomDocManager API instead.'
          },
          {
            name: 'y-websocket',
            message: 'UI components must not import y-websocket directly. Use RoomDocManager API instead.'
          },
          {
            name: 'y-indexeddb',
            message: 'UI components must not import y-indexeddb directly. Use RoomDocManager API instead.'
          },
          {
            name: 'y-webrtc',
            message: 'UI components must not import y-webrtc directly. Use RoomDocManager API instead.'
          }
        ]
      }
    ]
  }
};
```

This ensures all UI components access Yjs functionality only through the RoomDocManager's public API.

### Step 9: Add Zustand Store for Device UI State

Create `/client/src/stores/device-ui-store.ts`:

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ToolbarState {
  tool: 'pen' | 'highlighter' | 'text' | 'eraser' | 'stamp';
  size: number;
  color: string;
  opacity: number;
}

interface DeviceUIState {
  // Toolbar state
  toolbar: ToolbarState;
  
  // Track last seen scene per room (for ghost preview after clear)
  lastSeenSceneByRoom: Record<string, number>;
  
  // Collaboration mode preference
  collaborationMode: 'server' | 'peer';
  
  // UI preferences
  sidebarOpen: boolean;
  minimapVisible: boolean;
  
  // Actions
  setTool: (tool: ToolbarState['tool']) => void;
  setToolSize: (size: number) => void;
  setToolColor: (color: string) => void;
  setToolOpacity: (opacity: number) => void;
  updateLastSeenScene: (roomId: string, scene: number) => void;
  setCollaborationMode: (mode: 'server' | 'peer') => void;
  toggleSidebar: () => void;
  toggleMinimap: () => void;
}

export const useDeviceUIStore = create<DeviceUIState>()(
  persist(
    (set) => ({
      // Default state
      toolbar: {
        tool: 'pen',
        size: 2,
        color: '#000000',
        opacity: 1,
      },
      lastSeenSceneByRoom: {},
      collaborationMode: 'server',
      sidebarOpen: true,
      minimapVisible: true,
      
      // Actions
      setTool: (tool) => 
        set((state) => ({
          toolbar: { ...state.toolbar, tool }
        })),
        
      setToolSize: (size) =>
        set((state) => ({
          toolbar: { ...state.toolbar, size }
        })),
        
      setToolColor: (color) =>
        set((state) => ({
          toolbar: { ...state.toolbar, color }
        })),
        
      setToolOpacity: (opacity) =>
        set((state) => ({
          toolbar: { ...state.toolbar, opacity }
        })),
        
      updateLastSeenScene: (roomId, scene) =>
        set((state) => ({
          lastSeenSceneByRoom: {
            ...state.lastSeenSceneByRoom,
            [roomId]: scene
          }
        })),
        
      setCollaborationMode: (mode) =>
        set({ collaborationMode: mode }),
        
      toggleSidebar: () =>
        set((state) => ({ sidebarOpen: !state.sidebarOpen })),
        
      toggleMinimap: () =>
        set((state) => ({ minimapVisible: !state.minimapVisible })),
    }),
    {
      name: 'avlo:v1:ui', // localStorage key
      version: 1,
      // Migration function for future schema changes
      migrate: (persistedState: any, version: number) => {
        if (version === 0) {
          // Migration from version 0 to 1
          return { ...persistedState, version: 1 };
        }
        return persistedState as DeviceUIState;
      },
    }
  )
);
```

### Step 10: Add Zod Validation Schemas

Create `/packages/shared/src/schemas/index.ts`:

```typescript
import { z } from 'zod';

// Environment validation
export const EnvSchema = z.object({
  ROOM_TTL_DAYS: z.coerce.number().min(1).max(90).default(14),
  DEBUG_MODE: z.coerce.boolean().default(false),
  MAX_CLIENTS_PER_ROOM: z.coerce.number().min(1).max(200).default(105),
  ROOM_SIZE_WARNING_BYTES: z.coerce.number().default(8 * 1024 * 1024),
  ROOM_SIZE_READONLY_BYTES: z.coerce.number().default(10 * 1024 * 1024),
});

// WebSocket control frames
export const WSControlFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('persist_ack'),
    sizeBytes: z.number(),
    timestamp: z.string().datetime(),
    roomId: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('capacity_update'),
    currentClients: z.number(),
    maxClients: z.number(),
    readOnly: z.boolean(),
  }),
]);

// HTTP API schemas
export const CreateRoomSchema = z.object({
  title: z.string().max(100).optional(),
  provisional: z.boolean().optional(),
});

export const RoomMetadataSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastWriteAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  sizeBytes: z.number(),
  clientCount: z.number(),
});

// Type exports
export type Env = z.infer<typeof EnvSchema>;
export type WSControlFrame = z.infer<typeof WSControlFrameSchema>;
export type CreateRoomRequest = z.infer<typeof CreateRoomSchema>;
export type RoomMetadata = z.infer<typeof RoomMetadataSchema>;
```

### Step 11: Handle persist_ack for Authoritative Size

Add handler in RoomDocManager:

```typescript
// ADD: Method to handle persist acknowledgments
private handlePersistAck(ack: { sizeBytes: number; timestamp: string }): void {
  // Update room stats with authoritative size
  const oldStats = this.roomStats;
  this.roomStats = {
    bytes: ack.sizeBytes,
    cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
  };
  
  // Notify subscribers if changed
  if (oldStats?.bytes !== ack.sizeBytes) {
    this.statsSubscribers.forEach(cb => cb(this.roomStats));
  }
  
  // Check if room became read-only
  if (ack.sizeBytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
    console.warn('[RoomDocManager] Room is now read-only due to size limit');
    // Could emit an event or update UI state here
  }
}

// This will be connected to WebSocket control frames in Phase 7
```

### Step 12: Clean Up Constructor and Destroy

Simplify the constructor and ensure proper cleanup:

```typescript
constructor(roomId: RoomId, options?: RoomDocManagerOptions) {
  this.roomId = roomId;
  this.userId = generateULID(); // User ID for this session
  
  // Initialize Y.Doc with room GUID
  this.ydoc = new Y.Doc({ guid: roomId });
  
  // Initialize timing abstractions
  this.clock = options?.clock || new BrowserClock();
  this.frames = options?.frames || new BrowserFrameScheduler();
  
  // Initialize helpers
  this.sizeEstimator = new RollingGzipEstimator(options?.gzipImpl);
  
  // Initialize state
  this.publishState = {
    isDirty: false,
    presenceDirty: false,  // Track presence changes separately
    rafId: -1,
    lastPublishTime: 0,
    publishCostMs: 0,
    pendingUpdates: new UpdateRing(16), // Keep ring buffer for metrics
  };
  
  // Start with empty snapshot
  this._currentSnapshot = createEmptySnapshot();
  
  // Initialize root structure
  this.initializeDocument();
  
  // Setup observers
  this.setupObservers();
  
  // Start RAF loop
  this.startPublishLoop();
}

destroy(): void {
  // Set destroyed flag
  this.destroyed = true;
  
  // Stop RAF loop
  if (this.publishState.rafId !== -1) {
    cancelAnimationFrame(this.publishState.rafId);
  }
  
  // Remove Y.Doc observers
  this.ydoc.off('update', this.handleYDocUpdate);
  
  // Clear subscriptions
  this.snapshotSubscribers.clear();
  this.presenceSubscribers.clear();
  this.statsSubscribers.clear();
  
  // Destroy Y.Doc
  this.ydoc.destroy();
  
  // Clear references
  this._currentSnapshot = createEmptySnapshot();
  this.roomStats = null;
}
```

## Testing Strategy

### Unit Tests to Add

Create `/client/src/lib/__tests__/room-doc-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomDocManager } from '../room-doc-manager';
import { TestClock, TestFrameScheduler } from '../timing-abstractions';

describe('RoomDocManager', () => {
  let manager: RoomDocManager;
  let testClock: TestClock;
  let testFrames: TestFrameScheduler;
  
  beforeEach(() => {
    testClock = new TestClock();
    testFrames = new TestFrameScheduler(testClock);
    
    manager = new RoomDocManager('test-room', {
      clock: testClock,
      frames: testFrames,
    });
  });
  
  afterEach(() => {
    manager.destroy();
  });
  
  describe('mutate', () => {
    it('should apply mutations to Y.Doc', () => {
      manager.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const meta = root.get('meta') as Y.Map<any>;
        meta.set('test', 'value');
      });
      
      // Advance clock to trigger publish
      testFrames.flush();
      
      const snapshot = manager.currentSnapshot;
      expect(snapshot).toBeDefined();
      expect(snapshot.svKey).not.toBe('empty');
    });
    
    it('should reject mutations when room is read-only', () => {
      // Set room size to exceed limit
      manager['roomStats'] = {
        bytes: 16 * 1024 * 1024, // 16MB
        cap: 15 * 1024 * 1024,   // 15MB limit
      };
      
      const consoleSpy = vi.spyOn(console, 'warn');
      
      manager.mutate((ydoc) => {
        // This should not execute
        throw new Error('Should not execute');
      });
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('read-only')
      );
    });
  });
  
  describe('snapshot publishing', () => {
    it('should publish snapshots on RAF when dirty', () => {
      let snapshotCount = 0;
      
      manager.subscribeSnapshot(() => {
        snapshotCount++;
      });
      
      // Make a change
      manager.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        root.set('test', 'value');
      });
      
      // Should be dirty but not published yet
      expect(manager['publishState'].isDirty).toBe(true);
      expect(snapshotCount).toBe(1); // Initial empty snapshot
      
      // Trigger RAF
      testFrames.flush();
      
      // Should have published
      expect(manager['publishState'].isDirty).toBe(false);
      expect(snapshotCount).toBe(2);
    });
    
    it('should not publish when not dirty', () => {
      let snapshotCount = 0;
      
      manager.subscribeSnapshot(() => {
        snapshotCount++;
      });
      
      // Trigger multiple RAFs without changes
      testFrames.flush();
      testFrames.flush();
      testFrames.flush();
      
      // Should only have initial snapshot
      expect(snapshotCount).toBe(1);
    });
    
    it('should publish snapshot when only presence changes', () => {
      let snapshotCount = 0;
      
      manager.subscribeSnapshot(() => {
        snapshotCount++;
      });
      
      // Initial snapshot
      expect(snapshotCount).toBe(1);
      
      // Simulate presence update (no Y.Doc change)
      // This would normally come from awareness, but we can trigger directly
      manager['updatePresence']();
      
      // Advance throttle window if using fake timers
      // testClock.advance(34); // Just past 33ms throttle
      
      // Trigger RAF to process presenceDirty flag
      testFrames.flush();
      
      // Should have published due to presence change
      expect(snapshotCount).toBe(2);
      expect(manager['publishState'].presenceDirty).toBe(false);
    });
  });
});
```

## Verification Checklist

After refactoring, verify:

### ✅ Code Quality
- [ ] All .js files removed from src directories
- [ ] WriteQueue and CommandBus deleted
- [ ] SceneCapture deleted
- [ ] Simple mutate() method implemented
- [ ] RAF loop simplified with isDirty AND presenceDirty flags
- [ ] Destroyed flag added
- [ ] RoomStats type moved to shared package
- [ ] **Never cache Y references** rule strictly followed (helpers traverse root on demand)

### ✅ Dependencies
- [ ] zustand@^5.0.0 installed and configured
- [ ] @tanstack/react-query@^5.0.0 installed
- [ ] zod@^4 installed and schemas created
- [ ] ESLint no-restricted-imports configured to block direct Yjs imports in UI

### ✅ Functionality
- [ ] **Mutations**: Only through room.mutate(fn) with guards:
  - [ ] Mobile view-only (blocks writes)
  - [ ] ≥15MB read-only (blocks writes at ROOM_SIZE_READONLY_BYTES = 15_000_000)
  - [ ] >2MB frame size estimate (blocks oversized operations)
- [ ] **Snapshots**: 
  - [ ] RAF publisher runs continuously
  - [ ] Publishes on Y.Doc change (isDirty = true) OR presence change (presenceDirty = true)
  - [ ] Optional svKey optimization: skip publish if svKey unchanged and !presenceDirty
  - [ ] Initial EmptySnapshot exists at boot (never null)
  - [ ] Presence injected into snapshot
- [ ] **Scenes**: 
  - [ ] Assigned at commit time using currentScene = meta.scene_ticks.length
  - [ ] Renderer filters elements by scene === currentScene
- [ ] **Presence**:
  - [ ] ~30Hz throttled emission (33ms intervals)
  - [ ] Updates set presenceDirty flag for snapshot publishing
  - [ ] Smoothing/interpolation ready for Phase 8

### ✅ State Management
- [ ] **Zustand**: Device-local UI state only (toolbar, lastSeenSceneByRoom)
- [ ] **TanStack Query**: Server state only (metadata, lists, renames)
- [ ] **Zod**: Boundary validation only (WS control frames, HTTP payloads, env)

### ✅ Performance
- [ ] No timer-based publishing (pure RAF loop)
- [ ] Direct RAF loop with dirty flags
- [ ] Minimal overhead in mutate() (3 simple guards)
- [ ] No complex validation chains or queues

### ✅ Testing
- [ ] Unit tests pass with 15MB thresholds
- [ ] Memory usage stays under 1.3GB
- [ ] No memory leaks on destroy()
- [ ] Build artifacts (.js files) excluded via .gitignore

## Conclusion

This refactoring will transform an over-engineered 1000+ user enterprise system into the simple, elegant 15-user collaborative whiteboard specified in OVERVIEW.MD. By removing unnecessary complexity while preserving valuable patterns (types, config, helpers), we achieve both spec compliance and maintainability.

**Remember**: This is a small side project for resume optimization, not a production system for thousands of users. Keep it simple, keep it clean, keep it working.