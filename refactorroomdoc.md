# RoomDocManager Refactor Assessment

**Date**: 2025-10-30
**File**: `/client/src/lib/room-doc-manager.ts`
**Current Size**: 2345 lines
**Objective**: Safe refactoring to reduce file size and improve maintainability for AI agents

---

## Executive Summary

The RoomDocManager is the **single most critical file** in the AVLO codebase. It orchestrates:
- Y.js CRDT document lifecycle
- IndexedDB + WebSocket providers
- Two-epoch spatial indexing model
- Awareness/presence with cursor interpolation
- Gate-based initialization sequencing
- RAF-based snapshot publishing

**Key Risk**: This file has **extreme temporal coupling** - initialization order, gate timing, and state transitions are deeply interdependent. A naive extraction could introduce race conditions, memory leaks, or CRDT inconsistencies that manifest only under specific network conditions or user actions.

**Recommended Strategy**: **Vertical slice extraction** - extract complete, self-contained subsystems with clear boundaries, not horizontal layers. Prioritize extractions that reduce cognitive load without touching initialization order.

---

## Detailed Analysis

### Current Structure (Functional Blocks)

| Block | Lines | Risk | Extraction Difficulty |
|-------|-------|------|---------------------|
| **Awareness/Presence System** | ~400 | HIGH | VERY HIGH |
| **Provider Management** | ~350 | CRITICAL | EXTREME |
| **Two-Epoch Spatial Model** | ~350 | HIGH | HIGH |
| **Gate Management** | ~200 | HIGH | HIGH |
| **Snapshot Building & Publishing** | ~150 | MEDIUM | MEDIUM |
| **Subscription Management** | ~100 | LOW | LOW |
| **Y.Doc Helpers** | ~100 | LOW | LOW |
| **Lifecycle (Constructor/Destroy)** | ~160 | CRITICAL | EXTREME |
| **Registry** | ~150 | LOW | **ALREADY SEPARATE** |
| **Utilities** | ~50 | LOW | LOW |

### Critical Initialization Sequence

The constructor and initialization flow has **8 sequential dependencies**:

```
1. Create Y.Doc (with GUID)
   ↓
2. Create Awareness instance
   ↓
3. Setup doc observers (Y.Doc 'update' handler)
   ↓
4. Attach IndexedDB provider (MUST be before structures exist)
   ↓
5. Attach WebSocket provider (parallel with IDB)
   ↓
6. Wait for IDB ready + WS synced (350ms grace window)
   ↓
7. Initialize Y.js structures OR load from providers
   ↓
8. Setup array observers (MUST be after structures exist)
   ↓
9. Attach UndoManager (MUST be after observers)
   ↓
10. Start RAF publish loop (independent)
```

**Why This Matters**: The 350ms grace window (line 344) prevents a race where:
- Tab A creates fresh room
- Tab B joins same room
- Tab B's IDB loads empty state
- Tab B seeds fresh structures
- Tab A's WS update arrives with existing data
- **Result**: Conflicting Y.Doc states if not sequenced correctly

**Extraction Risk**: Moving provider initialization to a separate class requires **perfect preservation** of this timing, or you introduce cross-tab corruption bugs.

---

## Safe Extraction Opportunities (Ranked by Safety)

### ✅ **TIER 1: Safe & High Impact** (Recommend doing these)

#### 1. **Awareness Subsystem** (~400 lines → separate file)
**Lines**: 464-743 (awareness sending, backpressure, interpolation)
**Risk**: LOW-MEDIUM
**Impact**: Reduces file by ~17%
**Dependencies**: Needs `yAwareness`, `gates`, `userProfile`, `clock`

**Extraction Strategy**:
```typescript
// New file: awareness-manager.ts
export class AwarenessManager {
  constructor(
    private yAwareness: YAwareness,
    private gates: GateAccessor, // Read-only interface
    private userProfile: UserProfile,
    private clock: Clock,
  ) {}

  // Move all awareness methods here
  updateCursor(x?, y?): void
  updateActivity(activity): void
  scheduleAwarenessSend(): void
  sendAwareness(): void
  ingestAwareness(clientId, state, now): void
  getDisplayCursor(ps, now): ...
  buildPresenceView(): PresenceView
}
```

**Why Safe**:
- Self-contained state (no shared mutation with other systems)
- Clear input boundary (awareness instance, gates, profile)
- Clear output boundary (PresenceView)
- No timing dependencies on initialization order
- Can be injected in constructor **after** awareness instance is created

**Implementation Steps**:
1. Create `AwarenessManager` class in new file
2. Move all cursor interpolation types/constants
3. Move all awareness-related fields to manager
4. Replace direct calls with `this.awarenessManager.method()`
5. Test cursor smoothing, backpressure, reconnection edge cases

---

#### 2. **Gate Management** (~200 lines → separate file)
**Lines**: 1926-2022 (gate state, callbacks, debouncing)
**Risk**: LOW
**Impact**: Reduces file by ~8%
**Dependencies**: None (can be pure state machine)

**Extraction Strategy**:
```typescript
// New file: gate-manager.ts
export type GateName = 'idbReady' | 'wsConnected' | 'wsSynced' | 'awarenessReady' | 'firstSnapshot';

export class GateManager {
  private gates: Record<GateName, boolean>;
  private callbacks: Map<GateName, Set<() => void>>;
  private subscribers: Set<(gates: Readonly<Record<GateName, boolean>>) => void>;
  private debounceTimer: ReturnType<typeof setTimeout> | null;

  openGate(name: GateName): void
  closeGate(name: GateName): void
  getStatus(): Readonly<typeof this.gates>
  whenOpen(name: GateName): Promise<void>
  subscribe(cb: (gates) => void): () => void
  destroy(): void
}
```

**Why Safe**:
- Pure state machine (no Y.js coupling)
- No initialization order dependencies
- Can be injected as first constructor parameter
- All gate logic isolated

**Implementation Steps**:
1. Create `GateManager` with all gate state
2. Move gate-related methods
3. Replace `this.gates` with `this.gateManager.getStatus()`
4. Replace `this.openGate()` with `this.gateManager.openGate()`
5. Test gate transitions and debouncing

---

#### 3. **Subscription Hub** (~100 lines → separate file)
**Lines**: 162-166, 882-944
**Risk**: VERY LOW
**Impact**: Reduces file by ~4%
**Dependencies**: None (generic pub/sub)

**Extraction Strategy**:
```typescript
// New file: subscription-hub.ts
export class SubscriptionHub<T> {
  private subscribers = new Set<(value: T) => void>();

  subscribe(cb: (value: T) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  notify(value: T): void {
    this.subscribers.forEach(cb => cb(value));
  }

  clear(): void {
    this.subscribers.clear();
  }
}

// In RoomDocManager:
private snapshotHub = new SubscriptionHub<Snapshot>();
private presenceHub = new SubscriptionHub<PresenceView>();
private statsHub = new SubscriptionHub<RoomStats | null>();
private gateHub = new SubscriptionHub<GateStatus>();
```

**Why Safe**:
- Generic utility (no domain coupling)
- Zero initialization dependencies
- Reduces 4 duplicated patterns to 1 reusable class

---

### ⚠️ **TIER 2: Medium Risk, Medium Impact** (Consider carefully)

#### 4. **Snapshot Builder** (~150 lines → separate file)
**Lines**: 1577-1609, 2058-2115
**Risk**: MEDIUM
**Impact**: Reduces file by ~6%
**Dependencies**: Spatial index, maps, getCurrentScene, room stats, view transform

**Why Risky**:
- Depends on two-epoch model state (needsSpatialRebuild flag)
- Tightly coupled to spatial index rebuild logic
- Must coordinate with RAF loop for publishing

**Extraction Strategy** (if you proceed):
```typescript
// New file: snapshot-builder.ts
export class SnapshotBuilder {
  constructor(
    private spatialIndex: RBushSpatialIndex,
    private strokesById: Map<string, StrokeView>,
    private textsById: Map<string, TextView>,
    private getCurrentScene: () => number,
    private getRoomStats: () => RoomStats | null,
    private getViewTransform: () => ViewTransform,
    private buildPresenceView: () => PresenceView,
    private docVersion: () => number,
  ) {}

  buildSnapshot(): Snapshot {
    // Move composeSnapshotFromMaps logic here
  }
}
```

**Safety Requirement**: Must maintain reference to same spatial index, NOT clone it.

---

### 🚫 **TIER 3: High Risk, Avoid** (Do NOT extract without extreme care)

#### 5. **Provider Management** ❌
**Lines**: 1658-1899
**Risk**: **EXTREME**
**Why Dangerous**:
- IndexedDB **must** attach before structures exist (line 333)
- WebSocket **must** connect in parallel, not sequentially
- 350ms grace window is critical for cross-tab consistency
- Gate timing depends on provider event sequences
- Cleanup order in `destroy()` must match initialization order

**If you must extract**: Create a `ProviderCoordinator` but keep it **internal** to RoomDocManager. Do NOT make it a separate top-level class.

---

#### 6. **Two-Epoch Spatial Model** ❌
**Lines**: 1361-1575
**Risk**: **EXTREME**
**Why Dangerous**:
- Array observers and hydration share `needsSpatialRebuild` flag
- Observers ignore events during rebuild (line 1381)
- Rebuild triggers on scene change (line 2079)
- Race condition if rebuild flag is not synchronized perfectly

**Alternative**: Keep this code in RoomDocManager, add **internal methods** with clear names:
```typescript
private handleStrokeInsert(items: any[]): void { ... }
private handleStrokeDelete(deletedSet: Set<any>): void { ... }
private rebuildSpatialEpoch(): void { ... }
```

---

## Recommended Refactor Plan (Safest Path)

### **Phase 1**: Low-Risk Extractions (Week 1)
**Target**: -350 lines (15% reduction)

1. ✅ Extract `GateManager` (~200 lines)
   - Pure state machine
   - No Y.js coupling
   - Clear boundaries

2. ✅ Extract `SubscriptionHub` (~100 lines)
   - Generic utility
   - Reusable pattern

3. ✅ Add internal method groupings with JSDoc regions:
   ```typescript
   // ============================================================
   // AWARENESS & PRESENCE (~400 lines)
   // ============================================================

   // ============================================================
   // PROVIDER COORDINATION (~350 lines)
   // ============================================================
   ```

**Validation**: Run full test suite + manual cross-tab testing after each extraction.

---

### **Phase 2**: Medium-Risk Extraction (Week 2)
**Target**: -400 lines (17% reduction)

4. ⚠️ Extract `AwarenessManager` (~400 lines)
   - Self-contained subsystem
   - Inject after Y.Awareness creation
   - Test cursor interpolation, backpressure, reconnection

**Validation**:
- Test awareness with simulated network lag
- Test cursor smoothing across reconnects
- Test backpressure degradation

---

### **Phase 3**: Internal Refactoring (Week 3)
**Target**: Improve readability without extraction

5. ✅ Break two-epoch model into **named private methods**:
   ```typescript
   private observeStrokeInserts(event: Y.YArrayEvent<any>): void
   private observeStrokeDeletes(deletedSet: Set<any>): void
   private observeTextInserts(event: Y.YArrayEvent<any>): void
   private observeTextDeletes(deletedSet: Set<any>): void
   ```

6. ✅ Break provider initialization into **named private methods**:
   ```typescript
   private attachIndexedDBProvider(): void
   private attachWebSocketProvider(): void
   private handleIDBReady(): void
   private handleWSStatusChange(event: { status: string }): void
   ```

**Result**: File remains large (~1600 lines) but is more navigable with clear method names.

---

## What NOT to Do

### ❌ **Don't** extract providers to separate file
**Reason**: Initialization order is too critical. Provider timing errors manifest as cross-tab corruption bugs that are **impossible to reproduce in single-tab tests**.

### ❌ **Don't** extract spatial model to separate file
**Reason**: Two-epoch flag coordination with array observers is subtle. Breaking this causes spatial index desync bugs under rapid writes.

### ❌ **Don't** split constructor logic
**Reason**: Constructor orchestrates the critical 10-step initialization sequence. Splitting it breaks the narrative flow and increases cognitive load.

### ❌ **Don't** extract Y.Doc helpers to separate file
**Reason**: They're 5-line accessors. The abstraction cost exceeds the benefit.

### ❌ **Don't** create a "Services" layer
**Reason**: This creates horizontal coupling. RoomDocManager IS the orchestration layer. Adding another layer adds indirection without reducing complexity.

---

## Alternative: Vertical Slice Architecture

Instead of extracting code, consider **splitting RoomDocManager by feature**:

```
room-doc-manager.ts (500 lines) - Core orchestration
  ├── awareness-manager.ts (400 lines) - Presence/cursors
  ├── gate-manager.ts (200 lines) - Initialization gates
  ├── provider-coordinator.ts (350 lines) - IDB + WS lifecycle
  ├── spatial-coordinator.ts (350 lines) - Two-epoch model
  └── snapshot-publisher.ts (150 lines) - RAF + composition
```

Each file is a **vertical slice** with its own state, lifecycle, and clear dependencies.

**Trade-off**: More files, but each file is easier to understand in isolation.

---

## Testing Requirements for Any Refactor

### Critical Test Cases (Must Pass):
1. **Cross-tab sync**: Two tabs, one creates room, other joins → both see same state
2. **Offline → Online**: Disconnect WS, make changes, reconnect → changes sync
3. **IDB persistence**: Refresh tab → room state restores
4. **Cursor interpolation**: Move cursor rapidly → no jitter, smooth animation
5. **Backpressure**: Simulate slow network → awareness degrades gracefully
6. **Scene change**: Clear board → spatial index rebuilds, no stale strokes
7. **Rapid writes**: 100 strokes in 1 second → no spatial index desync
8. **Memory leaks**: Create/destroy manager 10 times → no retained objects

### How to Test:
```bash
# Unit tests (controlled environment)
npm test room-doc-manager

# Integration tests (real providers)
npm test integration/room-doc

# Manual cross-tab test
# 1. Open localhost:5173/room/test-room in Tab A
# 2. Open localhost:5173/room/test-room in Tab B
# 3. Draw in Tab A → should appear in Tab B
# 4. Close Tab A → cursor should disappear in Tab B
# 5. Refresh Tab B → drawings should persist
```

---

## Final Recommendation

### **Conservative Approach** (Recommended):
1. Extract `GateManager` (200 lines, LOW risk)
2. Extract `SubscriptionHub` (100 lines, VERY LOW risk)
3. Add JSDoc region comments for navigation
4. Break large methods into smaller named private methods
5. **Stop there** - keep file at ~2000 lines

**Result**: File is more navigable, ~15% smaller, with minimal risk.

---

### **Aggressive Approach** (Only if you have comprehensive test coverage):
1. Extract `GateManager` (200 lines)
2. Extract `SubscriptionHub` (100 lines)
3. Extract `AwarenessManager` (400 lines)
4. Extract `SnapshotBuilder` (150 lines)

**Result**: File is ~1500 lines, ~35% reduction, **MEDIUM risk of introducing bugs**.

---

### **Do NOT Attempt**:
- Extracting provider management
- Extracting two-epoch spatial model
- Splitting constructor/destroy logic
- Horizontal layering (services, repositories, etc.)

**Reason**: These are **temporal coupling nightmares**. The bugs you introduce will be **subtle, intermittent, and cross-tab specific** - the worst kind to debug.

---

## For AI Agents

When working with this file:

1. **Understand init sequence first** (lines 271-364, constructor + whenGateOpen callback)
2. **Trace gate dependencies** (when each gate opens/closes)
3. **Map state transitions** (needsSpatialRebuild, sawAnyDocUpdate, gates)
4. **Identify publish triggers** (what sets isDirty vs presenceDirty)
5. **Follow cleanup order** (destroy() reverses initialization)

**Key Insight**: This file is **state machine coordination code**. The complexity is inherent to the problem (orchestrating CRDT providers with spatial indexing). You can make it more readable, but you can't make it simpler without losing correctness.

---

## Conclusion

**Safest strategy**: Extract `GateManager` + `SubscriptionHub`, add internal method decomposition, stop at ~2000 lines.

**Medium strategy**: Also extract `AwarenessManager`, get to ~1600 lines, accept medium risk.

**Avoid**: Provider or spatial model extraction (extreme risk, subtle bugs).

**Root cause**: This file orchestrates 5 interdependent systems (Y.js, IDB, WS, Awareness, Spatial). The complexity is essential, not accidental. Refactoring should focus on **navigability** (clear method names, regions) over **size reduction** (arbitrary line count targets).
