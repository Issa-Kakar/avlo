# Phase 6 to 7 Integration Instructions

## 🚨 POST-IMPLEMENTATION FIX (January 2025)

### Infinite Re-render Loop Resolution

**Problem Encountered**: After initial implementation, navigating to the room page caused a "Maximum update depth exceeded" error due to an infinite re-render loop.

**Root Causes**:

1. **Immediate callback invocation**: The `subscribeGates` method was calling the callback synchronously during subscription, triggering state updates during React's mount phase
2. **Referential instability**: `getGateStatus()` was returning a new object on each call, causing `useSyncExternalStore` to detect changes even when the actual values hadn't changed

**Solution Implemented**: Option C - Stable Primitive Snapshot

Modified `useConnectionGates` hook to:

- Use `queueMicrotask` to defer callback execution, preventing synchronous state updates
- Return a stable string primitive (`"0|1|0|1|1"`) instead of an object
- Encode/decode between string and object representations

```typescript
// Actual implementation in client/src/hooks/use-connection-gates.ts
type GateSnapshot = `${0 | 1}|${0 | 1}|${0 | 1}|${0 | 1}|${0 | 1}`;

function encodeGates(gates: GateStatus): GateSnapshot {
  return `${+gates.idbReady}|${+gates.wsConnected}|${+gates.wsSynced}|${+gates.awarenessReady}|${+gates.firstSnapshot}`;
}

function decodeGates(snapshot: GateSnapshot): GateStatus {
  const [idb, wc, ws, aw, fs] = snapshot.split('|').map((n) => n === '1');
  return { idbReady: idb, wsConnected: wc, wsSynced: ws, awarenessReady: aw, firstSnapshot: fs };
}

// In the hook:
const subscribe = (onStoreChange: () => void) => {
  return room.subscribeGates(() => queueMicrotask(onStoreChange));
};
const getSnapshot = () => encodeGates(room.getGateStatus());
```

**Why This Approach**: For a simple online/offline badge in a small project (~15 concurrent users max), this solution is appropriately simple, avoiding over-engineering while solving the core issue.

---

## Executive Summary

We are transitioning from a working test harness (App.tsx) to a proper Room page structure while preserving all existing functionality. Phase 6 is complete with fully functional drawing, clear board, real-time sync, and offline capabilities. This integration creates minimal UI shells for your partner while you work on Phase 7 (Awareness).

## Current State Analysis

### ✅ What's Working (Phase 6 Complete)

1. **Drawing Pipeline**: Pen/highlighter with stroke commit, simplification, and Y.Doc mutations
2. **Clear Board**: Scene tick management with proper filtering
3. **Real-time Sync**: WebSocket + IndexedDB offline-first architecture
4. **Connection Gates**: G_WS_CONNECTED, G_WS_SYNCED, G_IDB_READY fully implemented
5. **Test Harness**: App.tsx with zoom/pan controls, clear button, stroke counter
6. **ViewTransform System**: ViewTransformContext and useViewTransform hook for zoom/pan
7. **Registry Pattern**: RoomDocManagerRegistry with acquire/release reference counting
8. **EmptySnapshot Guarantee**: Never null, created synchronously in constructor

### 🔧 What Exists But Isn't Integrated

1. **Zustand Store** (`client/src/stores/device-ui-store.ts`): Complete implementation with:
   - Toolbar state (tool, size, color, opacity)
   - lastSeenSceneByRoom tracking
   - Collaboration mode settings
   - localStorage persistence with versioning
2. **ConnectionStatus Component**: Shows connection states (needs update to remove "Syncing")
3. **MobileViewOnlyBanner**: Mobile detection and view-only enforcement
4. **Room Hooks**: useRoomDoc (with acquire/release), useRoomSnapshot, useRoomStats
5. **Config Constants**: All limits in @avlo/shared/config.ts (ROOM_CONFIG, STROKE_CONFIG, etc.)

### ❌ What's Missing

1. **Routing**: No React Router, hardcoded room ID ('test-room-001')
2. **Toolbar UI**: No tool selection or property controls
3. **Room Page Structure**: No dedicated room/whiteboard page
4. **subscribeGates Method**: Need to add event-driven gate status subscription

## Minimum Requirements to Unblock Partner

This is the lean path that gives your partner a clean UI playground while you work on Phase 7.

### 1. Routing + RoomPage Shell

Keep the test harness at `/` and mount a minimal `RoomPage` at `/room/:roomId`. Extract your current canvas block there, wrap with the existing `ViewTransform` provider, and pass the parsed `roomId`.

### 2. Guarded Adapter from Zustand → DrawingTool

Add the `toolbarToDeviceUI` function (defaults unknown tools to pen, clamps size, validates color). Wire it in `Canvas.tsx` so tool changes affect next stroke only.

### 3. Event-driven Connection Banner

Add `subscribeGates` to the RoomDocManager and a `useConnectionGates` hook that subscribes (no polling). Show a simple banner: **Online** / **Offline** (no "Syncing" state since this is offline-first).

### 4. Minimal Toolbar (pen + highlighter only)

Buttons + a size slider + a basic color input wired to your Zustand store. Leave other tools present but disabled.

### 5. StrictMode & Resilience

- Destroyed guards and idempotent `destroy()` already exist in RoomDocManager
- Wrap `RoomPage` with a tiny ErrorBoundary
- EmptySnapshot guarantee already in place

## Integration Plan

### Phase 1: Add Core Safety Features (30 min)

#### 1.1 Add subscribeGates to RoomDocManager

```typescript
// In IRoomDocManager interface (room-doc-manager.ts):
subscribeGates(cb: (gates: Readonly<{
  idbReady: boolean;
  wsConnected: boolean;
  wsSynced: boolean;
  awarenessReady: boolean;
  firstSnapshot: boolean;
}>) => void): Unsub;

// In implementation with proper memory safety:
private gateSubscribers = new Set<(gates: GateStatus) => void>();
private lastGateState: GateStatus | null = null;
private gateDebounceTimer: ReturnType<typeof setTimeout> | null = null;

public subscribeGates(cb: (gates: Readonly<GateStatus>) => void): Unsub {
  this.gateSubscribers.add(cb);
  // IMPORTANT: Do NOT call cb() immediately here to avoid infinite loops with useSyncExternalStore
  // The hook will call getGateStatus() to get the initial state

  return () => {
    this.gateSubscribers.delete(cb);
  };
}

private notifyGateChange() {
  const currentGates = this.getGateStatus();

  // Only notify if gates actually changed (shallow compare)
  if (this.lastGateState &&
      this.lastGateState.idbReady === currentGates.idbReady &&
      this.lastGateState.wsConnected === currentGates.wsConnected &&
      this.lastGateState.wsSynced === currentGates.wsSynced &&
      this.lastGateState.awarenessReady === currentGates.awarenessReady &&
      this.lastGateState.firstSnapshot === currentGates.firstSnapshot) {
    return;
  }

  this.lastGateState = { ...currentGates };

  // Debounce notifications by 150ms to prevent flicker
  if (this.gateDebounceTimer) {
    clearTimeout(this.gateDebounceTimer);
  }

  this.gateDebounceTimer = setTimeout(() => {
    this.gateSubscribers.forEach(cb => {
      try {
        cb(currentGates);
      } catch (err) {
        console.error('Error in gate subscriber:', err);
      }
    });
    this.gateDebounceTimer = null;
  }, 150);
}

// In destroy():
if (this.gateDebounceTimer) {
  clearTimeout(this.gateDebounceTimer);
  this.gateDebounceTimer = null;
}
this.gateSubscribers.clear();
```

Call `notifyGateChange()` in:

- `handleIDBReady()`
- `handleWSConnected()`
- `handleWSSynced()`
- `handleAwarenessReady()` (Phase 7)
- `handleFirstSnapshot()`

#### 1.2 Verify destroy guards (Already Implemented)

The RoomDocManager already has comprehensive destroy guards:

- The `destroy()` method is idempotent (checks `if (this.destroyed) return;`)
- All public methods already guard against destroyed state
- The registry's `release()` method calls `destroy()` when refCount reaches 0
- No additional implementation needed here

#### 1.3 Create ErrorBoundary component

```typescript
// client/src/components/ErrorBoundary.tsx
import React, { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="p-4 bg-red-50 border border-red-200 rounded">
          <h2 className="text-red-800 font-semibold">Something went wrong</h2>
          <details className="mt-2 text-sm text-red-600">
            <summary>Error details</summary>
            <pre className="mt-2 overflow-auto">
              {this.state.error?.stack}
            </pre>
          </details>
        </div>
      );
    }

    return this.props.children;
  }
}
```

### Phase 2: Routing Setup (30 min)

#### 2.1 Install React Router

```bash
npm install react-router-dom
npm install -D @types/react-router-dom
```

#### 2.2 Create Router Structure

Keep the existing test harness as default route, add room route:

- `/` → Existing test harness (unchanged)
- `/room/:roomId` → New RoomPage component
- `/test` → Alternative path to test harness

### Phase 3: Extract and Create RoomPage

#### 3.1 File Structure

```
client/src/
├── pages/
│   └── RoomPage.tsx         # Extract CanvasWithControls from App.tsx
├── components/
│   ├── Toolbar/
│   │   ├── Toolbar.tsx      # Tool selection UI
│   │   ├── ToolButton.tsx   # Individual tool buttons
│   │   └── ToolControls.tsx # Size, color, opacity controls
│   ├── Room/
│   │   ├── RoomHeader.tsx   # Room title, connection status, controls
│   │   └── RoomCanvas.tsx   # Canvas wrapper with overlay elements
│   └── Banners/
│       ├── ConnectionBanner.tsx  # Use existing ConnectionStatus
│       └── ReadOnlyBanner.tsx    # Size limit warnings
```

#### 3.2 RoomPage Implementation

Extract the `CanvasWithControls` component from App.tsx but:

- Replace hardcoded `'test-room-001'` with `useParams().roomId`
- Add proper layout structure for toolbar integration
- Use existing ViewTransformContext for zoom/pan
- **CRITICAL**: Use `useViewTransform()` hook, not create ViewTransform directly

### Phase 4: Integrate Zustand Store

#### 4.1 Create Guarded Adapter

In `client/src/lib/tools/types.ts`, create a guarded adapter:

```typescript
// Keep existing simplified interface for DrawingTool
export interface DeviceUIState {
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
}

// Add GUARDED adapter function to convert from Zustand
export function toolbarToDeviceUI(toolbar: ToolbarState): DeviceUIState {
  // Guard tool selection - default unknown tools to 'pen'
  let tool: 'pen' | 'highlighter' = 'pen';
  if (toolbar.tool === 'pen' || toolbar.tool === 'highlighter') {
    tool = toolbar.tool;
  }

  // Clamp size to reasonable range (1-64)
  const size = Math.max(1, Math.min(64, toolbar.size || 4));

  // Validate color format (default to black if invalid)
  const color = /^#[0-9A-Fa-f]{6}$/.test(toolbar.color) ? toolbar.color : '#000000';

  // Note: opacity is ignored for highlighter (renderer enforces 0.25)
  const opacity = Math.max(0, Math.min(1, toolbar.opacity || 1));

  return { tool, color, size, opacity };
}
```

#### 4.2 Update Canvas.tsx

Replace static deviceUI (lines 60-68) with Zustand integration:

```typescript
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { toolbarToDeviceUI } from '@/lib/tools/types';

// Inside Canvas component:
const toolbar = useDeviceUIStore((state) => state.toolbar);
const deviceUI: DeviceUIState = useMemo(
  () => toolbarToDeviceUI(toolbar),
  [toolbar.tool, toolbar.color, toolbar.size, toolbar.opacity],
);
```

### Phase 5: Connection UI with useSyncExternalStore

#### 5.1 Create useConnectionGates Hook

**⚠️ IMPORTANT**: The simplified version below will cause infinite re-render loops. See the "POST-IMPLEMENTATION FIX" section at the top of this document for the actual working implementation using stable primitive snapshots.

```typescript
// client/src/hooks/use-connection-gates.ts
// WARNING: This simplified version has issues - see actual implementation at top of document
import { useSyncExternalStore } from 'react';
import { useRoomDoc } from './use-room-doc';

export function useConnectionGates(roomId: string) {
  const room = useRoomDoc(roomId);

  // ACTUAL IMPLEMENTATION: Must use queueMicrotask and stable primitives
  // See POST-IMPLEMENTATION FIX section for working code
  const subscribe = (onStoreChange: () => void) => room.subscribeGates(() => onStoreChange());

  const getSnapshot = () => room.getGateStatus();
  const getServerSnapshot = getSnapshot;

  const gates = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return {
    gates,
    isOffline: !gates.wsConnected,
    isOnline: gates.wsSynced,
    hasFirstSnapshot: gates.firstSnapshot,
  };
}
```

#### 5.2 Update ConnectionStatus Component

```typescript
// Update client/src/components/ConnectionStatus.tsx
import { useConnectionGates } from '../hooks/use-connection-gates';

export function ConnectionStatus({ roomId }: ConnectionStatusProps) {
  const { isOffline, isOnline } = useConnectionGates(roomId);
  const stats = useRoomStats(roomId);

  let status = 'Offline';
  let className = 'text-gray-500';

  if (isOnline) {
    status = 'Online';
    className = 'text-green-500';
  }

  // Check if room is read-only
  if (stats && stats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
    status = 'Read-only';
    className = 'text-red-500';
  }

  return (
    <div className={`flex items-center gap-2 text-sm ${className}`}>
      <div className={`w-2 h-2 rounded-full ${className.replace('text', 'bg')}`} />
      <span>{status}</span>
    </div>
  );
}
```

#### 5.3 Connection Banner

Add conditional banner that shows when offline:

```typescript
{!isOnline && (
  <div className="fixed top-0 left-0 right-0 bg-amber-50 border-b border-amber-200 p-2 z-40">
    <p className="text-sm text-amber-800 text-center">
      📵 Offline - Your changes are saved locally
    </p>
  </div>
)}
```

### Phase 6: Clear Board Button (No Cooldown)

Create a simple ClearBoardButton component:

```typescript
interface ClearBoardButtonProps {
  room: IRoomDocManager;
  roomId: string;
  scene: number;
}

function ClearBoardButton({ room, roomId, scene }: ClearBoardButtonProps) {
  const updateLastSeenScene = useDeviceUIStore(s => s.updateLastSeenScene);

  const handleClear = () => {
    // Optimistically update lastSeenScene
    updateLastSeenScene(roomId, scene + 1);

    // Perform the clear
    room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const meta = root.get('meta') as Y.Map<unknown>;
      const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
      sceneTicks.push([Date.now()]);
    });
  };

  return (
    <button
      onClick={handleClear}
      className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
    >
      Clear Board
    </button>
  );
}
```

### Phase 7: Minimal Toolbar

```typescript
// Minimal toolbar with only implemented tools
const TOOLS = [
  { id: 'pen', label: 'Pen', icon: '✏️', enabled: true },
  { id: 'highlighter', label: 'Highlighter', icon: '🖊️', enabled: true },
  { id: 'text', label: 'Text', icon: 'T', enabled: false },
  { id: 'eraser', label: 'Eraser', icon: '🧹', enabled: false },
  { id: 'stamp', label: 'Stamp', icon: '⭐', enabled: false },
];
```

Only pen and highlighter should be clickable. Others show "Coming soon" tooltip.

## Critical Guardrails

### DO NOT MODIFY

1. **RoomDocManager**: Core CRDT logic is complete and tested (only add subscribeGates)
2. **DrawingTool**: Tool state freezing works perfectly
3. **Y.Doc Structure**: Scene management is architecturally sound
4. **Provider Order**: IndexedDB → WebSocket initialization order is critical
5. **Registry Pattern**: Always use acquire/release through registry

### SAFE TO MODIFY

1. **App.tsx**: Add routing while keeping test harness available
2. **Canvas.tsx**: Only the deviceUI initialization (lines 60-68)
3. **UI Components**: All new UI is safe to add
4. **Zustand Store**: Can add new actions/state as needed
5. **RoomDocManager**: ONLY to add subscribeGates method

## Implementation Sequence

### Step 1: Core Safety Features (30 min)

1. Add subscribeGates to RoomDocManager with:
   - Set-based subscriber management
   - Shallow comparison to prevent unnecessary updates
   - 150ms debounce to prevent UI flicker
   - Error isolation in subscriber callbacks
   - Cleanup in destroy()
2. Create ErrorBoundary component
3. Verify safety features already in place:
   - EmptySnapshot is never null (already implemented)
   - destroy() is idempotent (already implemented)
   - All public methods guard against destroyed state (already implemented)

### Step 2: Routing Setup (30 min)

1. Install react-router-dom
2. Wrap App with BrowserRouter in main.tsx
3. Add Routes in App.tsx keeping test harness at "/"
4. Create empty RoomPage.tsx at "/room/:roomId"

### Step 3: Room Page Creation (1 hour)

1. Extract CanvasWithControls to RoomPage
2. Replace hardcoded room ID with useParams
3. Add basic layout structure
4. Integrate ConnectionStatus component
5. Add MobileViewOnlyBanner
6. Wrap with ViewTransformProvider
7. Use `useViewTransform()` hook for controls
8. Reset view transform when roomId changes:
   ```typescript
   useEffect(() => {
     resetView(); // Reset zoom/pan when switching rooms
   }, [roomId, resetView]);
   ```

### Step 4: Zustand Integration (45 min)

1. Create guarded toolbarToDeviceUI adapter:
   - Default unknown tools to 'pen'
   - Clamp size to 1-64 range
   - Validate color format
2. Update Canvas.tsx to use Zustand store
3. Test drawing with dynamic tool state
4. Verify tool changes take effect on next stroke only

### Step 5: Connection UI (30 min)

1. Implement subscribeGates in RoomDocManager
2. Create useConnectionGates hook with useSyncExternalStore
3. Update ConnectionStatus to show only Online/Offline
4. Add connection banner to RoomPage
5. Test by going offline in DevTools

### Step 6: Clear Board UI (15 min)

1. Extract clear logic to reusable function
2. Create ClearBoardButton component (no cooldown)
3. Integrate lastSeenScene tracking

### Step 7: Minimal Toolbar (1 hour)

1. Create Toolbar component with pen/highlighter buttons
2. Add size slider (1-64 range)
3. Add color picker (basic HTML input)
4. Wire to Zustand actions
5. Style with Tailwind

## Partner Collaboration Points

### What Your Partner Can Work On

1. **Toolbar Design**: Style the toolbar component
2. **Color Picker**: Create a better color palette UI
3. **Size Preview**: Visual size indicator while adjusting
4. **Room Header**: Title display, share button
5. **Loading States**: Skeleton screens while room loads
6. **Error Pages**: 404, connection error designs
7. **Responsive Layout**: Mobile/tablet adaptations
8. **Export UI**: Export button design (gated behind G_FIRST_SNAPSHOT)
9. **Minimap UI**: Minimap container (gated behind G_FIRST_SNAPSHOT)

### What should be left alone

1. **RoomDocManager**: Core CRDT logic
2. **DrawingTool**: Pointer event handling
3. **Y.Doc mutations**: Any direct Yjs operations
4. **Provider setup**: WebSocket/IndexedDB initialization
5. **Gate logic**: Connection state management

## Notes for Phase 7 Integration

When you implement Awareness:

1. The presence system will automatically integrate
2. Cursor trails can be added as overlay on Canvas
3. User list can be added to RoomHeader
4. The infrastructure is ready in RoomDocManager
5. Awareness is already throttled to 30Hz
6. Use G_AWARENESS_READY gate for presence features

## Future Feature Flag Integration

While we're not implementing feature flags now, here's how they could be added later:

- Create a `config/features.ts` file with feature toggles
- Use environment variables to control features in production
- Conditionally render UI elements based on flags
- Keep flags at the component level, not in core logic

## Key Technical Details

1. **Registry Pattern**:
   - RoomPage uses `useRoomDoc(roomId)` which internally calls `registry.acquire(roomId)` and handles cleanup
   - Registry maintains reference counting and automatically calls `destroy()` when refCount reaches 0
   - The `destroy()` method is already idempotent and all public methods guard against destroyed state
2. **Gate Status**: Use `subscribeGates()` with `useSyncExternalStore` for event-driven updates
3. **Tool State**: Frozen at pointer-down via DrawingTool's state capture mechanism
4. **Highlighter Opacity**: Set in tool-renderer.ts (0.25), not from UI state
5. **Scene Management**: Clear board appends to `meta.scene_ticks[]`, currentScene = length
6. **Mobile Detection**: Uses both UserAgent and maxTouchPoints for reliability
7. **Connection States**: Only Online/Offline (this is offline-first, no "Syncing" state)

How to Access Rooms via Router

Now that the routing is set up, here's how you can access different parts of your application on
localhost:3000:

Available Routes:

1. Test Harness (what you've been using):


    - http://localhost:3000/ - Root path shows the test harness
    - http://localhost:3000/test - Alternative path for the test harness
    - Uses the hardcoded room ID: test-room-001

2. Room Pages (new functionality):


    - http://localhost:3000/room/[roomId] - Access any room by its ID
    - Examples:
        - http://localhost:3000/room/my-drawing-room
      - http://localhost:3000/room/collaboration-123
      - http://localhost:3000/room/test-room-001 (same room as test harness)

Key Features of the Room Page:

- Full drawing functionality with pen/highlighter tools
- Toolbar with tool selection, size slider (1-64px), and color picker
- Connection status indicator (Online/Offline)
- Clear Board button with lastSeenScene tracking
- Mobile view-only banner for mobile devices
- Zoom/pan controls integrated into the UI
- Dynamic room ID from the URL

What's Different from Test Harness:

- Room page uses dynamic room IDs from the URL
- Integrated Zustand store for persistent toolbar state
- Professional UI layout with proper component organization
- Event-driven connection status (no polling)
- Ready for Phase 7 awareness features

You can now open multiple browser tabs with different room IDs to test real-time collaboration between
rooms!
