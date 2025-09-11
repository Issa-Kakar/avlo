# PHASE 7: AWARENESS & PRESENCE SYSTEM - COMPLETE IMPLEMENTATION GUIDE

## Executive Summary

Phase 7 implements the **Awareness & Presence System** for Avlo using **WebSocket-only transport** (no WebRTC in this phase). The system provides real-time cursor tracking, user presence indicators, activity states, and roster management with **≤125ms p95 latency** for ~50 concurrent users (15 active drawers max).

**Critical Context**: ~70% of the infrastructure already exists from Phases 2-6. This phase primarily involves **connecting existing components** and implementing the missing awareness protocol integration.

**CRITICAL: "No Pings" Policy** - Awareness updates are sent ONLY when state changes (cursor, activity, name, color). The system uses dirty tracking with **0.5 world-unit cursor quantization** to prevent sub-pixel jitter from triggering unnecessary sends. Never send awareness frames just to maintain presence - Yjs handles disconnect detection automatically.

**CRITICAL: Best-Effort Backpressure** - The WebSocket bufferedAmount check is an optimization, not a requirement. If we cannot read the buffer (provider internals change, ws unavailable), we MUST still send awareness updates to prevent silent failures.

**Identity Model**: Per-tab identity with memory-only userId (already generated via `ulid()` in RoomDocManager constructor). Names and colors are randomly generated per tab using crypto.getRandomValues(). No persistence to localStorage, no custom names/colors UI in this phase.

**Gate Lifecycle**: `G_AWARENESS_READY` opens on WebSocket 'connected' and **MUST close on 'disconnected'**. This ensures cursors hide immediately when offline. Presence rendering requires both `G_AWARENESS_READY && G_FIRST_SNAPSHOT` to be true.

**Import Note**: The Yjs Awareness class must be imported as `YAwareness` from `y-protocols/awareness` to avoid collision with the app's `Awareness` interface defined in `packages/shared/src/types/awareness.ts`.

## Scope Definition

### IN SCOPE (Phase 7)

- ✅ y-websocket awareness protocol integration (client + server)
- ✅ Client-side backpressure implementation (WebSocket.bufferedAmount monitoring)
- ✅ User identity system (random names/colors per tab, memory-only, no UI customization)
- ✅ Cursor tracking and rendering (pointer glyph + tiny label)
- ✅ Minimal cursor trails (12-24 points, 600ms buffer)
- ✅ Header badge roster (user count + activity indicators)
- ✅ Presence throttling (network: 10-13Hz, UI: ≤30Hz)
- ✅ G_AWARENESS_READY gate opening
- ✅ Mobile view-only awareness (no cursor emit)

## Current Implementation Status

### ✅ COMPLETED Infrastructure (From Phases 2-6)

#### 1. **Type System** (`packages/shared/src/types/awareness.ts`)

```typescript
// ALREADY DEFINED - DO NOT RECREATE
interface Awareness {
  userId: UserId;
  name: string;
  color: string;
  cursor?: { x: number; y: number }; // world coordinates
  activity: 'idle' | 'drawing' | 'typing';
  seq: number; // CRITICAL for future RTC: deduplicates when WS+RTC race in parallel
  ts: number;
  aw_v?: number;
}

interface PresenceView {
  users: Map<UserId, { name; color; cursor?; activity; lastSeen }>;
  localUserId: UserId;
}
```

#### 2. **RoomDocManager Foundation** (`client/src/lib/room-doc-manager.ts`)

- ✅ `subscribePresence()` method with 30Hz throttling
- ✅ `buildPresenceView()` placeholder (returns empty Map)
- ✅ Presence injection into snapshots
- ✅ Gate tracking including `awarenessReady`
- ✅ User ID generation (`ulid()`)
- ✅ Throttle utility with cleanup

#### 3. **React Hooks** (`client/src/hooks/`)

- ✅ `usePresence(roomId)` - Full implementation ready
- ✅ `useConnectionGates()` - Includes `hasAwareness` flag
- ✅ Gate subscription with stable primitives

#### 4. **Canvas Infrastructure** (`client/src/canvas/`, `client/src/renderer/`)

- ✅ Coordinate transform system (world↔canvas)
- ✅ Render layer architecture with presence slot
- ✅ 60 FPS RAF loop with dirty tracking
- ✅ `drawPresenceOverlays()` placeholder in render pipeline

#### 5. **UI Components**

- ✅ `UsersModal` placeholder ready
- ✅ `ConnectionStatus` component
- ✅ Toolbar with tool state tracking
- ✅ Modern floating UI design system

### ❌ MISSING Implementation (Phase 7 Tasks)

1. **Awareness Instance Creation & Connection**
2. **WebSocket Provider Awareness Enable**
3. **Backpressure Logic Implementation**
4. **User Identity System**
5. **Cursor Position Tracking**
6. **Cursor Rendering Implementation**
7. **Roster UI Implementation**
8. **Activity State Management**

## Architecture & Data Flow

### System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Client (Browser)                     │
├─────────────────────────────────────────────────────────────┤
│  Canvas Events → Local Awareness → WebSocket → Server       │
│                                                              │
│  RoomDocManager                                              │
│  ├── Y.Doc (authoritative)                                  │
│  ├── Awareness Instance (ephemeral) ← PHASE 7 ADDS THIS     │
│  ├── WebsocketProvider (awareness enabled) ← PHASE 7 ENABLE │
│  └── PresenceView Builder (30Hz throttled)                  │
│                                                              │
│  Snapshot (≤60 FPS)                                          │
│  └── presence: PresenceView (injected)                      │
│                                                              │
│  UI Components                                               │
│  ├── Canvas (cursor overlay rendering)                      │
│  ├── UsersModal (roster list)                               │
│  └── ConnectionStatus (awareness indicator)                 │
└─────────────────────────────────────────────────────────────┘
                               ↕
┌─────────────────────────────────────────────────────────────┐
│                      Server (Node.js)                        │
├─────────────────────────────────────────────────────────────┤
│  @y/websocket-server                                         │
│  └── Awareness protocol relay (no persistence)              │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow Pipeline

```
1. POINTER MOVE (Canvas)
   → [worldX, worldY] = canvasToWorld(x, y)
   → updateLocalAwareness({ cursor: { x: worldX, y: worldY } })

2. AWARENESS SEND (10-13Hz network rate)
   → Check WebSocket.bufferedAmount
   → Skip if > 64KB (backpressure)
   → awareness.setLocalState(state)
   → WebSocket binary frame

3. AWARENESS RECEIVE
   → WebSocket message
   → awareness 'update' event
   → updatePresenceThrottled() (30Hz UI rate)
   → buildPresenceView()
   → Mark presenceDirty

4. RAF PUBLISH (≤60 FPS)
   → Check isDirty || presenceDirty
   → buildSnapshot() with presence injection
   → Notify subscribers
   → Render cursors in drawPresenceOverlays()
```

## Detailed Implementation Steps

### CRITICAL: Backpressure Recovery Pattern

**Best-effort backpressure check - always send if bufferedAmount cannot be read.** The backpressure optimization is opportunistic, not required for correctness. If we cannot access the WebSocket or read bufferedAmount, we MUST still send the awareness update. Only skip when we successfully read bufferedAmount AND it's above the threshold. This prevents silent failures when provider internals change or ws is temporarily unavailable.

### STEP 1: Enable Awareness in WebSocket Provider

#### 1.1 Import Awareness Dependencies

**File**: `client/src/lib/room-doc-manager.ts`

Update the imports to include the Yjs Awareness class (aliased to avoid collision with app types):

```typescript
import { Awareness as YAwareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import { AWARENESS_CONFIG } from '@avlo/shared';
import { clearCursorTrails } from '@/renderer/layers/presence-cursors';
```

#### 1.2 Create Awareness Instance

**Location**: In `RoomDocManagerImpl` class

Add private fields (using aliased type to avoid collision with app's Awareness interface):

```typescript
private yAwareness?: YAwareness;

// Awareness event handler storage for cleanup
private _onAwarenessUpdate: (() => void) | null = null;
private _onWebSocketStatus: ((event: { status: string }) => void) | null = null;
```

In constructor, after Y.Doc creation:

```typescript
// Create awareness instance bound to this doc
this.yAwareness = new YAwareness(this.ydoc);
```

#### 1.3 Connect Awareness to WebSocket Provider

**Location**: `initializeWebSocketProvider()` method

CURRENT CODE:

```typescript
this.websocketProvider = new WebsocketProvider(wsUrl, this.roomId, this.ydoc, {
  awareness: undefined, // Disabled for now (Phase 7)
  maxBackoffTime: 10000,
  resyncInterval: 5000,
});
```

CHANGE TO:

```typescript
this.websocketProvider = new WebsocketProvider(wsUrl, this.roomId, this.ydoc, {
  awareness: this.yAwareness, // ENABLE AWARENESS
  maxBackoffTime: 10000,
  resyncInterval: 5000,
});
```

#### 1.4 Wire Awareness Events

After WebSocket provider creation, add:

````typescript
// Store bound handlers for cleanup
this._onAwarenessUpdate = () => {
  // Mark presence dirty for next RAF publish
  this.publishState.presenceDirty = true;

  // Trigger throttled presence update for subscribers
  if (this.updatePresenceThrottled) {
    this.updatePresenceThrottled();
  }
};

this._onWebSocketStatus = (event: { status: string }) => {
  if (event.status === 'connected' && !this.gates.awarenessReady) {
    // Open awareness gate immediately on WS connect
    // No need to wait for remote awareness states
    this.openGate('awarenessReady');

    // Mark dirty to trigger initial awareness send on reconnect
    if (this.yAwareness) {
      this.awarenessIsDirty = true;
      this.scheduleAwarenessSend();
    }
  } else if (event.status === 'disconnected' && this.gates.awarenessReady) {
    // CRITICAL: Close awareness gate on disconnect
    // This ensures cursors hide immediately when offline
    this.closeGate('awarenessReady');

    // Clear cursor trails to prevent stale data across sessions
    // Import at the top: import { clearCursorTrails } from '@/renderer/layers/presence-cursors';
    clearCursorTrails();

    // Mark presence dirty to trigger immediate UI update
    this.publishState.presenceDirty = true;

    // Clear local cursor state
    this.localCursor = undefined;

    // NOTE: We keep awarenessIsDirty true if it was true,
    // and let sendAwareness() handle the retry logic when reconnected.
    // This ensures pending state changes are sent once back online.

    // Force awareness state clear to signal departure to peers
    if (this.yAwareness) {
      try {
        this.yAwareness.setLocalState(null);
      } catch {}
    }
  }
};

// Listen for awareness updates
if (this.yAwareness && this._onAwarenessUpdate) {
  this.yAwareness.on('update', this._onAwarenessUpdate);
}

// Open awareness gate when WebSocket provider is connected
// (not when local state changes, which happens immediately)
if (this.websocketProvider && this._onWebSocketStatus) {
  this.websocketProvider.on('status', this._onWebSocketStatus);
}

// CRITICAL: Add gate transition handler to flush presence when firstSnapshot opens
// This prevents cursors from being permanently hidden when awareness arrives before snapshot
// Add this to your existing gate opening logic (e.g., in openGate method):
```typescript
// In openGate method:
private openGate(gateName: keyof typeof this.gates): void {
  const wasOpen = this.gates[gateName];
  if (wasOpen) return; // Already open

  this.gates[gateName] = true;

  // Force presence publish when both gates are open for the first time
  // The RAF loop is already running from constructor, so just mark dirty
  if (!wasOpen && gateName === 'firstSnapshot' && this.gates.awarenessReady) {
    this.publishState.presenceDirty = true;
    // No need to call schedulePublish() - the loop is already running
  }
  // Similar check if awarenessReady opens after firstSnapshot
  if (!wasOpen && gateName === 'awarenessReady' && this.gates.firstSnapshot) {
    this.publishState.presenceDirty = true;
    // No need to call schedulePublish() - the loop is already running
  }

  // Notify subscribers
  const callbacks = this.gateCallbacks.get(gateName);
  if (callbacks) {
    callbacks.forEach((cb) => cb());
    callbacks.clear();
  }

  // Notify gate subscribers about the change
  this.notifyGateChange();

  // Note: G_FIRST_SNAPSHOT opens in buildSnapshot() when first doc-derived snapshot publishes
  // Do NOT open it here based on other gates
}
```

#### 1.5 Update buildPresenceView()
**Location**: `buildPresenceView()` method

CURRENT CODE:
```typescript
private buildPresenceView(): PresenceView {
  return {
    users: new Map(),
    localUserId: this.userId,
  };
}
````

CHANGE TO:

```typescript
private buildPresenceView(): PresenceView {
  const users = new Map<UserId, any>();

  if (this.yAwareness) {
    this.yAwareness.getStates().forEach((state) => {
      if (state.userId && state.userId !== this.userId) {
        users.set(state.userId, {
          name: state.name || 'Anonymous',
          color: state.color || '#808080',
          cursor: state.cursor,
          activity: state.activity || 'idle',
          // Use the timestamp from the remote state if available
          lastSeen: typeof state.ts === 'number' ? state.ts : Date.now(),
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

### STEP 2: Implement User Identity System

#### 2.1 Create Identity Generator

**File**: Create `client/src/lib/user-identity.ts`

```typescript
// Random adjective-animal name lists
const ADJECTIVES = [
  'Swift',
  'Bright',
  'Happy',
  'Clever',
  'Bold',
  'Calm',
  'Eager',
  'Gentle',
  'Keen',
  'Lively',
  'Noble',
  'Quick',
  'Sharp',
  'Wise',
  'Zesty',
];

const ANIMALS = [
  'Fox',
  'Bear',
  'Wolf',
  'Eagle',
  'Owl',
  'Hawk',
  'Lion',
  'Tiger',
  'Lynx',
  'Otter',
  'Seal',
  'Whale',
  'Raven',
  'Swan',
  'Deer',
];

const COLORS = [
  '#FF6B6B',
  '#4ECDC4',
  '#45B7D1',
  '#96CEB4',
  '#FFEAA7',
  '#DDA0DD',
  '#98D8C8',
  '#F7DC6F',
  '#85C1E2',
  '#F8B739',
  '#52B788',
  '#E76F51',
];

export interface UserProfile {
  name: string;
  color: string;
}

export function generateUserProfile(): UserProfile {
  // Generate random indices using crypto.getRandomValues
  const randomValues = new Uint32Array(3);
  crypto.getRandomValues(randomValues);

  // Random name from lists
  const adjIndex = randomValues[0] % ADJECTIVES.length;
  const animalIndex = randomValues[1] % ANIMALS.length;
  const name = `${ADJECTIVES[adjIndex]} ${ANIMALS[animalIndex]}`;

  // Random color from palette
  const colorIndex = randomValues[2] % COLORS.length;
  const color = COLORS[colorIndex];

  return { name, color };
}
```

#### 2.2 Initialize User Profile in RoomDocManager

**File**: `client/src/lib/room-doc-manager.ts`

Add import:

```typescript
import { generateUserProfile, UserProfile } from './user-identity';
```

Add private field:

```typescript
private userProfile: UserProfile;
```

In constructor (after `this.userId = ulid();`):

```typescript
// Generate random user profile per tab
this.userProfile = generateUserProfile();
```

After awareness creation:

```typescript
// Mark awareness as dirty to trigger initial send when gate opens
// Don't send immediately - wait for awareness gate to open
if (this.yAwareness) {
  // Store initial values but don't send yet
  this.localActivity = 'idle';
  this.awarenessIsDirty = true;
  // The actual send will happen when G_AWARENESS_READY opens
  // via the WebSocket status handler
}
```

### STEP 3: Implement Backpressure Logic

#### 3.1 Add Backpressure Configuration

**File**: `packages/shared/src/config.ts`

Already exists:

```typescript
export const AWARENESS_CONFIG = {
  AWARENESS_HZ_BASE_WS: 15,
  AWARENESS_HZ_DEGRADED: 8,
  WEBSOCKET_BUFFER_HIGH_BYTES: 64 * 1024, // 64KB
  WEBSOCKET_BUFFER_CRITICAL_BYTES: 256 * 1024, // 256KB
};
```

#### 3.2 Create Awareness Publisher with Backpressure

**File**: `client/src/lib/room-doc-manager.ts`

Add private fields:

```typescript
private localCursor: { x: number; y: number } | undefined = undefined;
private localActivity: 'idle' | 'drawing' | 'typing' = 'idle';
private awarenessSeq = 0;
private awarenessSendTimer: number | null = null;
private awarenessSkipCount = 0;
private awarenessSendRate = AWARENESS_CONFIG.AWARENESS_HZ_BASE_WS;
private awarenessIsDirty = false;
private lastSentAwareness: { cursor?: { x: number; y: number }; activity: string; name: string; color: string } | null = null;
```

Add method:

```typescript
private scheduleAwarenessSend(): void {
  // Only schedule if not already scheduled and we have changes to send
  if (this.awarenessSendTimer !== null || !this.awarenessIsDirty) return;

  // Calculate interval with degradation
  const baseInterval = 1000 / this.awarenessSendRate;
  const jitter = (Math.random() - 0.5) * 20; // ±10ms jitter
  const interval = Math.max(75, Math.min(150, baseInterval + jitter));

  this.awarenessSendTimer = window.setTimeout(() => {
    this.awarenessSendTimer = null;
    this.sendAwareness();
  }, interval);
}

private sendAwareness(): void {
  // Check if gate is closed (offline) - remain dirty and retry
  if (!this.gates.awarenessReady) {
    // Keep dirty flag and reschedule to try again when online
    this.scheduleAwarenessSend();
    return;
  }

  // Only send if we have changes (implements "no pings" policy)
  if (!this.awarenessIsDirty) {
    return;
  }

  // Check provider availability - remain dirty and retry
  if (!this.yAwareness || !this.websocketProvider) {
    this.scheduleAwarenessSend();
    return;
  }

  // Check if actual state changed (not just seq/ts)
  const currentState = {
    cursor: this.localCursor,
    activity: this.localActivity,
    name: this.userProfile.name,
    color: this.userProfile.color,
  };

  // Compare with last sent state (shallow compare of meaningful fields)
  if (this.lastSentAwareness) {
    const cursorSame = (!currentState.cursor && !this.lastSentAwareness.cursor) ||
      (currentState.cursor && this.lastSentAwareness.cursor &&
       currentState.cursor.x === this.lastSentAwareness.cursor.x &&
       currentState.cursor.y === this.lastSentAwareness.cursor.y);

    const otherSame = currentState.activity === this.lastSentAwareness.activity &&
      currentState.name === this.lastSentAwareness.name &&
      currentState.color === this.lastSentAwareness.color;

    if (cursorSame && otherSame) {
      // Nothing actually changed, clear dirty flag and return (no reschedule needed)
      this.awarenessIsDirty = false;
      return;
    }
  }

  // Best-effort backpressure check - only skip if we can successfully read bufferedAmount AND it's high
  let shouldSkipDueToBackpressure = false;
  try {
    const ws: WebSocket | undefined = (this.websocketProvider as any)?.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const bufferedAmount = ws.bufferedAmount ?? 0;
      if (bufferedAmount > AWARENESS_CONFIG.WEBSOCKET_BUFFER_HIGH_BYTES) {
        shouldSkipDueToBackpressure = true;
        this.awarenessSkipCount++;

        // If critical, degrade send rate
        if (bufferedAmount > AWARENESS_CONFIG.WEBSOCKET_BUFFER_CRITICAL_BYTES) {
          this.awarenessSendRate = AWARENESS_CONFIG.AWARENESS_HZ_DEGRADED;
        }
      } else if (this.awarenessSendRate < AWARENESS_CONFIG.AWARENESS_HZ_BASE_WS) {
        // Buffer recovered, restore rate
        this.awarenessSendRate = AWARENESS_CONFIG.AWARENESS_HZ_BASE_WS;
      }
    }
    // If ws is missing or not OPEN, do NOT treat as fatal - proceed to send
  } catch {
    // Swallow exception - proceed to send normally
  }

  // Only skip if we successfully detected high buffer
  if (shouldSkipDueToBackpressure) {
    // Stay dirty AND schedule the next attempt
    this.scheduleAwarenessSend();
    return;
  }

  // Actually send awareness (only increment seq when we really send)
  // Future RTC: seq provides total ordering across WS+RTC channels - prevents duplicates/jitter
  this.awarenessSeq++;
  this.yAwareness.setLocalState({
    userId: this.userId,  // Use existing per-tab userId
    name: this.userProfile.name,
    color: this.userProfile.color,
    cursor: this.localCursor,
    activity: this.localActivity,
    seq: this.awarenessSeq,
    ts: Date.now(),
    aw_v: 1,
  });

  // Update last sent state and clear dirty flag
  this.lastSentAwareness = { ...currentState };
  this.awarenessIsDirty = false;
}

// Public API for updating cursor
public updateCursor(worldX: number | undefined, worldY: number | undefined): void {
  // Apply 0.5 world-unit quantization to prevent sub-pixel jitter
  const quantize = (v: number): number => Math.round(v / 0.5) * 0.5;

  const newCursor = (worldX !== undefined && worldY !== undefined)
    ? { x: quantize(worldX), y: quantize(worldY) }
    : undefined;

  // Check if cursor actually changed (now comparing quantized values)
  const cursorChanged = (!this.localCursor && newCursor) ||
    (this.localCursor && !newCursor) ||
    (this.localCursor && newCursor &&
     (this.localCursor.x !== newCursor.x || this.localCursor.y !== newCursor.y));

  if (cursorChanged) {
    this.localCursor = newCursor;
    this.awarenessIsDirty = true;

    // Only schedule send if gate is open
    // If offline, the dirty flag remains set and will trigger send on reconnect
    if (this.gates.awarenessReady) {
      this.scheduleAwarenessSend();
    }
  }
}

// Public API for updating activity
public updateActivity(activity: 'idle' | 'drawing' | 'typing'): void {
  if (this.localActivity !== activity) {
    this.localActivity = activity;
    this.awarenessIsDirty = true;

    // Only schedule send if gate is open
    // If offline, the dirty flag remains set and will trigger send on reconnect
    if (this.gates.awarenessReady) {
      this.scheduleAwarenessSend();
    }
  }
}
```

#### 3.4 Add Cleanup

In `destroy()` method, add:

```typescript
// Clear awareness timer and dirty flag
if (this.awarenessSendTimer !== null) {
  clearTimeout(this.awarenessSendTimer);
  this.awarenessSendTimer = null;
}
this.awarenessIsDirty = false;

// Clear cursor trails to prevent memory leaks and cross-room contamination
clearCursorTrails();

// Cleanup WebSocket status listener
if (this.websocketProvider && this._onWebSocketStatus) {
  try {
    (this.websocketProvider as any).off?.('status', this._onWebSocketStatus);
  } catch {}
  this._onWebSocketStatus = null;
}

// Cleanup awareness defensively
if (this.yAwareness) {
  // Signal departure by setting local state to null
  try {
    this.yAwareness.setLocalState(null);
  } catch {}

  // Unregister event listeners (if the off method exists)
  if (this._onAwarenessUpdate) {
    try {
      (this.yAwareness as any).off?.('update', this._onAwarenessUpdate);
    } catch {}
    this._onAwarenessUpdate = null;
  }

  // Call destroy if it exists
  try {
    if (typeof (this.yAwareness as any).destroy === 'function') {
      (this.yAwareness as any).destroy();
    }
  } catch {}

  this.yAwareness = undefined;
}
```

### STEP 4: Implement Cursor Position Tracking

#### 4.1 Update Canvas Component

**File**: `client/src/canvas/Canvas.tsx`

Add cursor tracking to pointer move handler:

```typescript
const handlePointerMove = useCallback(
  (e: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Calculate canvas coordinates
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    // Convert to world coordinates
    const [worldX, worldY] = viewTransform.canvasToWorld(canvasX, canvasY);

    // Update awareness cursor (not on mobile)
    if (!isMobile) {
      roomDoc.updateCursor(worldX, worldY);
    }

    // ... existing drawing logic ...
  },
  [roomDoc, viewTransform, isMobile],
);
```

Add pointer leave handler:

```typescript
const handlePointerLeave = useCallback(() => {
  // Clear cursor when pointer leaves canvas
  roomDoc.updateCursor(undefined, undefined);

  // ... existing logic ...
}, [roomDoc]);
```

Update activity state:

```typescript
// In handlePointerDown
roomDoc.updateActivity('drawing');

// In handlePointerUp
roomDoc.updateActivity('idle');
```

### STEP 5: Implement Cursor Rendering

#### 5.1 Create Cursor Renderer

**File**: Create `client/src/renderer/layers/presence-cursors.ts`

```typescript
import { PresenceView } from '@avlo/shared';
import { ViewTransform } from '@/canvas/ViewTransform';

interface CursorTrail {
  points: Array<{ x: number; y: number; t: number }>;
  lastUpdate: number;
}

const cursorTrails = new Map<string, CursorTrail>();
const MAX_TRAIL_POINTS = 24;
const MAX_TRAIL_AGE = 600; // ms
const TRAIL_DECAY_RATE = 320; // ms

// Clear all cursor trails (call on disconnect or room change)
export function clearCursorTrails(): void {
  cursorTrails.clear();
}

export function drawCursors(
  ctx: CanvasRenderingContext2D,
  presence: PresenceView,
  viewTransform: ViewTransform,
  gates: { awarenessReady: boolean; firstSnapshot: boolean },
): void {
  // Single render guard: ONLY draw when both gates are open
  // Presence intake continues always - we just don't render until both gates pass
  if (!gates.awarenessReady || !gates.firstSnapshot) {
    return;
  }

  const now = Date.now();

  // Update trails and render cursors
  presence.users.forEach((user, userId) => {
    if (!user.cursor) {
      // No cursor, skip rendering but keep trail aging
      return;
    }

    // Update trail
    let trail = cursorTrails.get(userId);
    if (!trail) {
      trail = { points: [], lastUpdate: now };
      cursorTrails.set(userId, trail);
    }

    // Add new point if moved enough (matches cursor quantization)
    const lastPoint = trail.points[trail.points.length - 1];
    const distance = lastPoint
      ? Math.hypot(user.cursor.x - lastPoint.x, user.cursor.y - lastPoint.y)
      : Infinity;

    if (distance > 0.5) {
      // 0.5 world units threshold (same as cursor quantization)
      trail.points.push({
        x: user.cursor.x,
        y: user.cursor.y,
        t: now,
      });
      // Update lastUpdate when adding a point
      trail.lastUpdate = now;
    } else {
      // Still update lastUpdate to keep aging accurate even if not moving
      trail.lastUpdate = now;
    }

    // Trim old points
    while (trail.points.length > 0) {
      if (now - trail.points[0].t > MAX_TRAIL_AGE || trail.points.length > MAX_TRAIL_POINTS) {
        trail.points.shift();
      } else {
        break;
      }
    }

    // Draw trail if not degraded
    if (presence.users.size <= 25) {
      drawTrail(ctx, trail, viewTransform, user.color, now);
    }

    // Draw cursor pointer
    const [canvasX, canvasY] = viewTransform.worldToCanvas(user.cursor.x, user.cursor.y);
    drawCursorPointer(ctx, canvasX, canvasY, user.color);

    // Draw name label
    drawNameLabel(ctx, canvasX, canvasY, user.name, user.color);
  });

  // Cleanup old trails
  for (const [userId, trail] of cursorTrails.entries()) {
    if (now - trail.lastUpdate > MAX_TRAIL_AGE && !presence.users.has(userId)) {
      cursorTrails.delete(userId);
    }
  }
}

function drawTrail(
  ctx: CanvasRenderingContext2D,
  trail: CursorTrail,
  viewTransform: ViewTransform,
  color: string,
  now: number,
): void {
  if (trail.points.length < 2) return;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Draw each segment with its own alpha for proper gradient effect
  for (let i = 1; i < trail.points.length; i++) {
    const prevPoint = trail.points[i - 1];
    const currPoint = trail.points[i];

    // Calculate alpha based on current point's age
    const age = now - currPoint.t;
    const alpha = Math.exp(-age / TRAIL_DECAY_RATE);

    if (alpha < 0.01) continue;

    // Transform both points
    const [prevX, prevY] = viewTransform.worldToCanvas(prevPoint.x, prevPoint.y);
    const [currX, currY] = viewTransform.worldToCanvas(currPoint.x, currPoint.y);

    // Draw this segment with its specific alpha
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(prevX, prevY);
    ctx.lineTo(currX, currY);
    ctx.stroke();
  }

  ctx.restore();
}

function drawCursorPointer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();

  // Draw pointer shape (triangle with tail)
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(x, y); // Tip
  ctx.lineTo(x - 4, y + 10); // Left
  ctx.lineTo(x + 1, y + 7); // Middle
  ctx.lineTo(x + 6, y + 12); // Right
  ctx.closePath();

  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

function drawNameLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  name: string,
  color: string,
): void {
  ctx.save();

  // Position label below and right of cursor
  const labelX = x + 8;
  const labelY = y + 14;

  // Measure text
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  const metrics = ctx.measureText(name);
  const padding = 4;
  const width = metrics.width + padding * 2;
  const height = 16;

  // Draw pill background
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, width, height, height / 2);
  ctx.fill();

  // Draw text
  ctx.fillStyle = '#FFFFFF';
  ctx.globalAlpha = 1;
  ctx.fillText(name, labelX + padding, labelY + 12);

  ctx.restore();
}
```

#### 5.2 Integrate Cursor Rendering into Render Pipeline

**Critical Architecture Update**: The render pipeline needs gate status to control presence rendering. This requires threading gates through multiple layers:

1. **Update RenderLoopConfig** (`client/src/renderer/RenderLoop.ts`):
   - Add `getGates: () => GateStatus` to config interface
   - Import `GateStatus` type from `@/hooks/use-connection-gates`
   - Pass gates from config to drawPresenceOverlays in tick()

2. **Update Canvas Component** (`client/src/canvas/Canvas.tsx`):
   - Provide `getGates: () => roomDoc.getGateStatus()` in renderLoop.start() config
   - This connects RoomDocManager's gate state to the render pipeline

3. **Update drawPresenceOverlays** (`client/src/renderer/layers/index.ts`):

   ```typescript
   export function drawPresenceOverlays(
     ctx: CanvasRenderingContext2D,
     snapshot: Snapshot,
     view: ViewTransform,
     _viewport: ViewportInfo,
     gates: GateStatus,
   ): void {
     // Draw cursors only when both gates are open
     drawCursors(ctx, snapshot.presence, view, {
       awarenessReady: gates.awarenessReady,
       firstSnapshot: gates.firstSnapshot,
     });
   }
   ```

### STEP 6: Implement Roster UI

#### 6.1 Update UsersModal Component

**File**: `client/src/pages/components/UsersModal.tsx`

```typescript
import { usePresence } from '@/hooks/use-presence';
import { Badge } from '@/components/ui/badge';

export function UsersModal({ roomId, isOpen, onClose }: UsersModalProps) {
  const presence = usePresence(roomId);

  if (!isOpen) return null;

  // Get entries (userId, user) for stable React keys
  const userEntries = Array.from(presence.users.entries());
  const activeCount = userEntries.filter(([_, u]) => u.activity === 'drawing').length;
  const typingCount = userEntries.filter(([_, u]) => u.activity === 'typing').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold">
            Active Users ({userEntries.length})
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            ✕
          </button>
        </div>

        <div className="flex gap-2 mb-4">
          {activeCount > 0 && (
            <Badge variant="secondary">✏️ Drawing {activeCount}</Badge>
          )}
          {typingCount > 0 && (
            <Badge variant="secondary">⌨️ Typing {typingCount}</Badge>
          )}
        </div>

        <div className="space-y-2 max-h-96 overflow-y-auto">
          {userEntries.map(([userId, user]) => (
            <div key={userId} className="flex items-center gap-3 p-2 rounded hover:bg-gray-50">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: user.color }}
              />
              <span className="flex-1">{user.name}</span>
              <span className="text-xs text-gray-500">
                {user.activity}
              </span>
            </div>
          ))}
        </div>

        {userEntries.length === 0 && (
          <p className="text-gray-500 text-center py-8">
            No other users connected
          </p>
        )}
      </div>
    </div>
  );
}
```

#### 6.2 Add Header Badge Counter

**File**: `client/src/pages/RoomPage.tsx`

Add to header area:

```typescript
const presence = usePresence(roomId);
const userCount = presence.users.size + 1; // +1 for self

// In header JSX
<div className="flex items-center gap-2">
  <Badge variant="outline" className="gap-1">
    <span className="w-2 h-2 rounded-full bg-green-500" />
    {userCount} {userCount === 1 ? 'user' : 'users'}
  </Badge>
</div>
```

### STEP 7: Mobile Support

#### 7.1 Disable Cursor Emission on Mobile

Already handled in Canvas.tsx with:

```typescript
if (!isMobile) {
  roomDoc.updateCursor(worldX, worldY);
}
```

#### 7.2 Mobile Awareness State

The sendAwareness method already handles mobile correctly by checking isMobile when building the state:

```typescript
// In sendAwareness method, when calling setLocalState:
// Check if mobile device
const isMobile = /Mobi|Android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;

// Actually send awareness (only increment seq when we really send)
// Future RTC: seq provides total ordering across WS+RTC channels - prevents duplicates/jitter
this.awarenessSeq++;
this.yAwareness.setLocalState({
  userId: this.userId, // Use existing per-tab userId
  name: this.userProfile.name,
  color: this.userProfile.color,
  cursor: isMobile ? undefined : this.localCursor, // No cursor on mobile
  activity: isMobile ? 'idle' : this.localActivity, // Always idle on mobile
  seq: this.awarenessSeq,
  ts: Date.now(),
  aw_v: 1,
});
```

Note: Mobile detection is already integrated in the main sendAwareness logic. The dirty flag system ensures mobile devices don't send unnecessary updates when nothing changes.

### STEP 8: Performance Optimizations

#### 8.1 Degrade Under Load

In cursor rendering, add peer count checks:

```typescript
// In drawCursors()
const peerCount = presence.users.size;

// Degrade trails if too many peers
const enableTrails = peerCount <= 25 && !prefersReducedMotion();

// Reduce trail buffer size
const maxPoints = peerCount > 10 ? 12 : 24;
```

#### 8.2 Respect Reduced Motion

```typescript
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
```

## Configuration Values

### Network Rates (from `packages/shared/src/config.ts`)

- **Awareness Send Rate**: 10-13 Hz (75-100ms intervals)
- **UI Update Rate**: ≤30 Hz (throttled)
- **Render Rate**: ≤60 FPS (RAF-based)
- **Backpressure Threshold**: 64KB bufferedAmount
- **Critical Threshold**: 256KB (degrade to 6-7 Hz)

### Limits

- **Max Trail Points**: 24 (12 when degraded)
- **Trail Age**: 600ms
- **Trail Decay**: τ = 240-320ms
- **Cursor Quantization**: 0.5 world units (applied to both cursor position and trail points)
- **Name Length**: ≤40 characters

## Validation Points

### Gate States

1. **G_AWARENESS_READY** opens when:
   - WebSocket connected (no timeout, no remote state requirement)
   - Opens immediately on WS 'connected' status

   **G_AWARENESS_READY** closes when:
   - WebSocket disconnected
   - Closes immediately on WS 'disconnected' status
   - Triggers presence dirty update to hide cursors
   - Clears local awareness state

2. **G_FIRST_SNAPSHOT** opens when:
   - First document-derived snapshot is applied to UI
   - Typically ≤1 rAF after Y.Doc update

3. **Single Render Guard**:
   - Draw cursors/presence ONLY when `awarenessReady && firstSnapshot`
   - Presence intake never stops (always process updates)
   - When `firstSnapshot` flips true, call `drawCursors()` once to flush any queued presence

### Mobile Behavior

- **No cursor emission** (cursor: undefined)
- **Activity always 'idle'**
- **Can see other cursors**
- **Appears in roster**

## Architecture Invariants

### NEVER VIOLATE

1. **Awareness is ephemeral** - Never persist to Redis/PostgreSQL
2. **Presence is injected** - Always part of Snapshot, not Y.Doc
3. **Throttling is critical** - Network ≠ UI rates
4. **Backpressure is client-side** - Server runs unmodified
5. **Mobile is view-only** - No cursor emission
6. **Gate lifecycle** - G_AWARENESS_READY MUST close on disconnect, open on connect
7. **Offline behavior** - Cursors hide immediately when offline (gate-driven)

### Data Flow Rules

1. **Cursor coordinates are world space** - Transform per-frame for view independence
2. **Sequence-based ordering** - Use seq for deduplication, not timestamps
3. **Activity states are exclusive** - idle | drawing | typing
4. **Cleanup on disconnect** - Remove from presence immediately

## Common Pitfalls to Avoid

1. **DO NOT** create multiple Awareness instances (keep single yAwareness per manager)
2. **DO NOT** store awareness in Y.Doc
3. **DO NOT** send awareness on every pointermove (mark dirty and coalesce)
4. **DO NOT** block UI on network backpressure
5. **DO NOT** use timestamps for ordering (use seq)
6. **DO NOT** render cursors before gates open
7. **DO NOT** forget cleanup in destroy()
8. **DO NOT** import Awareness from y-websocket (use y-protocols/awareness with alias)
9. **DO NOT** confuse app's Awareness interface with Yjs YAwareness class
10. **DO NOT** forget to close G_AWARENESS_READY on disconnect
11. **DO NOT** keep sending awareness when offline or when nothing changes (violates "no pings" policy)
12. **DO NOT** leave cursors visible when awareness gate closes
13. **DO NOT** increment seq without actually sending (only bump when setLocalState is called)
14. **DO NOT** try to vary alpha within a single Canvas path (stroke per-segment for gradients)
15. **DO NOT** make backpressure check a hard requirement (it's best-effort; always send if can't read buffer)
16. **DO NOT** forget to clear cursor trails on disconnect/destroy (causes memory leaks and cross-room contamination)
17. **DO NOT** forget to force a presence publish when firstSnapshot gate opens (prevents hidden cursors)
18. **DO NOT** skip cursor quantization (causes sub-pixel jitter and violates "no pings" policy)

## Critical Implementation Requirements Summary

### 1. Best-Effort Backpressure (Prevents Silent Failures)

```typescript
// ✅ CORRECT - Try to read buffer, but always send if we can't
let shouldSkip = false;
try {
  const ws = (provider as any)?.ws;
  if (ws?.readyState === WebSocket.OPEN) {
    shouldSkip = (ws.bufferedAmount ?? 0) > threshold;
  }
} catch {
  /* proceed to send */
}
if (shouldSkip) {
  reschedule();
  return;
}
// Always reaches setLocalState() unless we KNOW buffer is high

// ❌ WRONG - Hard dependency on reading buffer
const ws = (provider as any).ws;
if (!ws) {
  reschedule();
  return;
} // Silent failure!
```

### 2. Gate Transition Presence Flush (Prevents Hidden Cursors)

```typescript
// ✅ CORRECT - Force publish when both gates open
openGate(gateName: keyof GateStatus): void {
  const wasOpen = this.gates[gateName];
  this.gates[gateName] = true;

  // Force presence publish when both gates become true
  if (!wasOpen && this.gates.firstSnapshot && this.gates.awarenessReady) {
    this.publishState.presenceDirty = true;
    this.schedulePublish(); // Kick rAF immediately
  }
}
```

### 3. Cursor Quantization (Prevents Jitter & Unnecessary Sends)

```typescript
// ✅ CORRECT - Quantize before storing and comparing
const quantize = (v: number) => Math.round(v / 0.5) * 0.5;
const newCursor = worldX != null ? { x: quantize(worldX), y: quantize(worldY) } : undefined;

// ❌ WRONG - Raw floating point causes constant "dirty" state
const newCursor = { x: worldX, y: worldY }; // Sub-pixel jitter!
```
