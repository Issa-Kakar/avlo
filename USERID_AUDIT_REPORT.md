# AVLO userId Audit Report: Persistent Identity Implementation

**Date:** 2025-10-18
**Scope:** Complete codebase audit for userId usage and persistent identity requirements
**Objective:** Identify all userId usage points and determine changes needed for persistent cross-session/cross-tab user identity

---

## Executive Summary

This comprehensive audit examined all 47+ occurrences of `userId` across the AVLO codebase. The current implementation uses **ephemeral per-tab session IDs** with a critical architectural flaw: **dual userId generation** (Canvas.tsx and RoomDocManager generate independent IDs).

**Key Finding:** The codebase is well-architected for persistent userId migration, requiring changes to only **3 core files** with no breaking changes to storage, networking, or rendering layers.

**Critical Bug Discovered:** Canvas and RoomDocManager generate separate userIds, breaking undo/redo functionality.

---

---

## 1. Current Implementation Analysis

### 1.1 Dual UserId Generation (CRITICAL BUG)

**Location 1: RoomDocManager**
```typescript
// File: /client/src/lib/room-doc-manager.ts (Line 275)
this.userId = ulid(); // User ID for this session
```
- **Format:** Plain ULID (e.g., `01HXYZ123ABC`)
- **Scope:** RoomDocManager instance lifetime
- **Usage:** Awareness broadcasting, undo/redo transaction origin

**Location 2: Canvas.tsx**
```typescript
// File: /client/src/canvas/Canvas.tsx (Lines 190-198)
const [userId] = useState(() => {
  let id = sessionStorage.getItem('avlo-user-id');
  if (!id) {
    id = 'user-' + ulid();
    sessionStorage.setItem('avlo-user-id', id);
  }
  return id;
});
```
- **Format:** `'user-' + ULID` (e.g., `user-01HXYZ123ABC`)
- **Storage:** `sessionStorage` (tab-scoped)
- **Usage:** Passed to tools → stamped on strokes/texts

**Impact:**
- Tools commit strokes with Canvas userId (`user-01HXYZ...`)
- RoomDocManager scopes undo/redo to its own userId (`01HXYZ...`)
- **Undo/redo DOES NOT WORK for committed strokes** (different transaction origins)

### 1.2 Current Flow Diagram

```
┌──────────────────────────────────────────────────────────────┐
│ Browser Tab Opens                                            │
│                                                              │
│ Canvas.tsx mounts                                            │
│  └─> userId = sessionStorage['avlo-user-id']                │
│      OR 'user-' + ulid()                                    │
│      Result: "user-01HXYZ..."                               │
└─────────────────┬────────────────────────────────────────────┘
                  │
                  ├──────────────────┐
                  │                  │
                  ▼                  ▼
        ┌─────────────────┐  ┌──────────────────┐
        │ Tools           │  │ RoomDocManager   │
        │                 │  │ Created          │
        │ DrawingTool     │  │                  │
        │ TextTool        │  │ this.userId =    │
        │ EraserTool      │  │   ulid()         │
        │                 │  │                  │
        │ Receive:        │  │ Result:          │
        │ "user-01HXYZ.." │  │ "01ABCDEF..."    │
        └────────┬────────┘  └────────┬─────────┘
                 │                    │
                 │                    │
                 ▼                    ▼
        ┌─────────────────┐  ┌──────────────────┐
        │ Stroke Commits  │  │ Awareness        │
        │ Y.Doc Storage   │  │ Broadcast        │
        │                 │  │                  │
        │ { userId:       │  │ { userId:        │
        │   "user-..." }  │  │   "01ABC..." }   │
        │                 │  │                  │
        │ Transaction     │  │ Presence View    │
        │ origin =        │  │ localUserId =    │
        │ "01ABC..."      │  │ "01ABC..."       │
        │ (from manager)  │  │                  │
        └─────────────────┘  └──────────────────┘
                 │                    │
                 └──────────┬─────────┘
                            │
                            ▼
                    ⚠️ MISMATCH! ⚠️
        Strokes have userId: "user-01HXYZ..."
        Undo/redo scoped to: "01ABCDEF..."
        → Undo/redo BROKEN
```

### 1.3 Storage Scope Comparison

| Storage Type | Current Scope | Lifetime | Persistent userId Scope |
|--------------|---------------|----------|-------------------------|
| `sessionStorage['avlo-user-id']` | Per-tab | Until tab close | ❌ Replace |
| RoomDocManager `this.userId` | Per-manager | Until destroy | ✅ Update source |
| Strokes/Texts in Y.Doc | Per-document | Permanent | ✅ Already persisted |
| Awareness state | Per-connection | Until disconnect | ⚠️ Ephemeral (OK) |

---

## 2. Complete Usage Inventory

### 2.1 File Summary (20 Implementation Files)

#### Core Document Management
1. `/client/src/lib/room-doc-manager.ts` - **11 occurrences** (generation, awareness, undo/redo)
2. `/client/src/canvas/Canvas.tsx` - **5 occurrences** (generation, tool injection)

#### Tools
3. `/client/src/lib/tools/DrawingTool.ts` - **5 occurrences** (storage, stroke/shape commits)
4. `/client/src/lib/tools/EraserTool.ts` - **3 occurrences** (storage, unused)
5. `/client/src/lib/tools/TextTool.ts` - **2 occurrences** (storage, text commits)

#### Rendering
6. `/client/src/renderer/layers/presence-cursors.ts` - **3 occurrences** (cursor tracking, cleanup)

#### Type Definitions
7. `/packages/shared/src/types/identifiers.ts` - **1 occurrence** (type alias)
8. `/packages/shared/src/types/room.ts` - **2 occurrences** (Stroke, TextBlock)
9. `/packages/shared/src/types/snapshot.ts` - **3 occurrences** (StrokeView, TextView, EmptySnapshot)
10. `/packages/shared/src/types/awareness.ts` - **2 occurrences** (Awareness, PresenceView)

#### UI Components
11. `/client/src/pages/components/UsersModal.tsx` - **1 occurrence** (React keys)
12. `/client/src/pages/components/UserAvatarCluster.tsx` - **1 occurrence** (React keys)

### 2.2 Usage by Category

#### A. Generation & Initialization (2 sources - BUG)

| Location | Line | Format | Storage | Purpose |
|----------|------|--------|---------|---------|
| RoomDocManager constructor | 275 | `ulid()` | None (in-memory) | Awareness + undo/redo |
| Canvas.tsx useState | 194 | `'user-' + ulid()` | sessionStorage | Tool injection |

#### B. Document Storage (Persistent in Y.Doc → IndexedDB → Redis)

| Structure | File | Line | Purpose | Immutable? |
|-----------|------|------|---------|------------|
| `Stroke.userId` | types/room.ts | 22 | Track creator | Yes |
| `TextBlock.userId` | types/room.ts | 43 | Track creator | Yes |
| `StrokeView.userId` | types/snapshot.ts | 41 | Read-only view | Yes |
| `TextView.userId` | types/snapshot.ts | 61 | Read-only view | Yes |

**Serialization:** Plain string in Yjs encoding, no special handling required for format change.

#### C. Awareness (Ephemeral - WebSocket Only)

| Location | File | Line | Purpose | Persisted? |
|----------|------|------|---------|------------|
| `Awareness.userId` | types/awareness.ts | 5 | Protocol field | No |
| Broadcast state | room-doc-manager.ts | 653 | Send to peers | No |
| Ingestion | room-doc-manager.ts | 435 | Receive from peers | No |
| Filtering | room-doc-manager.ts | 522 | Exclude self | No |

**Network Protocol:** userId transmitted as plain string in awareness messages, no validation.

#### D. Presence & Rendering

| Usage | File | Line | Purpose | Impact |
|-------|------|------|---------|--------|
| `PresenceView.localUserId` | types/awareness.ts | 31 | Self-identification | Filter self from UI |
| Cursor trails Map key | presence-cursors.ts | 62, 136 | Track per-user trails | Stable identity needed |
| Avatar cluster React key | UserAvatarCluster.tsx | 43 | Stable list rendering | Prevents flicker |
| Peer smoother Map key | room-doc-manager.ts | 220, 436 | Interpolation state | Continuity on reconnect |

#### E. Tool Integration (Dependency Injection)

| Tool | File | Lines | Constructor Param | Usage |
|------|------|-------|-------------------|-------|
| DrawingTool | DrawingTool.ts | 26, 54, 63 | `userId: string` | Stamp on strokes (402, 587) |
| TextTool | TextTool.ts | 37, 322 | `userId: string` | Stamp on text blocks |
| EraserTool | EraserTool.ts | 22, 33, 43 | `userId: string` | Stored but **unused** |

**Injection Point:** Canvas.tsx lines 575, 599, 627, 636 - passes sessionStorage userId to tools.

#### F. Undo/Redo (Transaction Origin)

```typescript
// File: room-doc-manager.ts (Line 964)
mutate(fn: (ydoc: Y.Doc) => void): void {
  this.ydoc.transact(() => {
    fn(this.ydoc);
  }, this.userId); // ← Origin for Yjs UndoManager
}
```

**Yjs Behavior:** UndoManager creates per-origin undo stacks. If transaction origin doesn't match userId in committed stroke, undo fails to find operations.

---

## 3. Critical Issues

### 3.1 Dual UserId Generation (P0 - BREAKING)

**Symptom:** Undo/redo does not work for strokes/texts committed through tools.

**Root Cause:**
1. Canvas generates `userId = 'user-01HXYZ...'`
2. RoomDocManager generates `this.userId = '01ABCDEF...'`
3. Tools receive Canvas userId → strokes stamped with `'user-01HXYZ...'`
4. RoomDocManager uses its own userId for `transact(fn, this.userId)` → `'01ABCDEF...'`
5. Yjs UndoManager cannot find operations to undo (origin mismatch)

**Evidence:**
- Canvas.tsx line 194: `id = 'user-' + ulid()`
- RoomDocManager line 275: `this.userId = ulid()` (no 'user-' prefix)
- DrawingTool line 430: `userId` from Canvas
- RoomDocManager line 964: `this.userId` as transaction origin

**Impact:**
- ❌ User cannot undo their own strokes
- ❌ User cannot redo undone strokes
- ❌ Per-user undo history broken

**Resolution Priority:** **CRITICAL** - Must be fixed immediately, regardless of persistent userId work.

### 3.2 Per-Tab Identity (P1 - UX Issue)

**Symptom:** Same user in multiple tabs appears as different users.

**Current Behavior:**
- User opens room in Tab A → userId `user-01AAA...`, name "Swift Fox"
- User opens same room in Tab B → userId `user-01BBB...`, name "Bold Eagle"
- Presence shows 2 users (both are the same person)
- Strokes from Tab A and Tab B attributed to different users

**Impact:**
- ❌ No cross-tab identity continuity
- ❌ User's own work appears fragmented
- ❌ Confusing presence display (multiple "me")

### 3.3 Session-Only Persistence (P2 - Long-term UX)

**Symptom:** User identity lost on tab close or browser restart.

**Current Storage:** `sessionStorage['avlo-user-id']` (cleared on tab close)

**Impact:**
- ❌ No cross-session attribution
- ❌ Cannot build persistent user history
- ❌ Cannot implement "my strokes" filtering
- ❌ Cannot implement per-user clear board

### 3.4 Type Inconsistencies (P3 - Code Quality)

**Issue:** Some types use `UserId`, others use `string`.

| Type | File | Line | Should Be |
|------|------|------|-----------|
| `Stroke.userId` | types/room.ts | 22 | `UserId` ✅ |
| `TextBlock.userId` | types/room.ts | 43 | `UserId` ✅ |
| `StrokeView.userId` | types/snapshot.ts | 41 | `string` ❌ |
| `TextView.userId` | types/snapshot.ts | 61 | `string` ❌ |

**Impact:** Weak type safety, but no runtime issues.

---

File: **client/src/lib/user-identity.ts**
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
later in room-doc-manager.ts:
  constructor(roomId: RoomId, options?: RoomDocManagerOptions) {
    this.roomId = roomId;
    this.userId = ulid(); // User ID for this session

    // Generate random user profile per tab
    this.userProfile = generateUserProfile(); 
    ....
---

## 7. Appendices

### Appendix A: Complete Line-by-Line Reference

#### RoomDocManager (`/client/src/lib/room-doc-manager.ts`)
- Line 141: Field declaration `private readonly userId: string`
- Line 220: Peer smoothers map `Map<string, PeerSmoothing>`
- Line 275: Constructor userId generation `this.userId = ulid()`
- Line 278: User profile generation `this.userProfile = generateUserProfile()`
- Line 435: Awareness ingestion parameter `userId: string`
- Line 436: Get peer smoother `this.peerSmoothers.get(userId)`
- Line 439: Set peer smoother `this.peerSmoothers.set(userId, ps)`
- Line 522: Presence filtering `state.userId !== this.userId`
- Line 533: Map key `users.set(state.userId, {...})`
- Line 540: State access `state.userId`
- Line 547: Return value `localUserId: this.userId`
- Line 652-661: Awareness broadcast `userId: this.userId`
- Line 964: Mutation origin `this.ydoc.transact(..., this.userId)`
- Line 1539: Awareness update handler filtering

#### Canvas.tsx (`/client/src/canvas/Canvas.tsx`)
- Line 190-198: userId generation and sessionStorage
- Line 575: EraserTool constructor `userId` parameter
- Line 599: DrawingTool constructor `userId` parameter
- Line 627: DrawingTool (shape) constructor `userId` parameter
- Line 636: TextTool constructor `userId` parameter

#### DrawingTool (`/client/src/lib/tools/DrawingTool.ts`)
- Line 26: Field declaration `private userId: string`
- Line 54: Constructor parameter `userId: string`
- Line 63: Constructor assignment `this.userId = userId`
- Line 402: Local variable `const userId = this.userId`
- Line 430: Stroke commit `userId,`
- Line 587: Perfect shape commit `userId: this.userId`

#### EraserTool (`/client/src/lib/tools/EraserTool.ts`)
- Line 22: Field declaration `private userId: string`
- Line 33: Constructor parameter `userId: string`
- Line 43: Constructor assignment `this.userId = userId`
- Line 368: Comment about undo origin

#### TextTool (`/client/src/lib/tools/TextTool.ts`)
- Line 37: Constructor parameter `private userId: string`
- Line 322: Text commit `userId: this.userId`

#### Presence Cursors (`/client/src/renderer/layers/presence-cursors.ts`)
- Line 62: forEach loop variable `(user, userId)`
- Line 68-78: Cursor trail tracking by userId
- Line 136: Cleanup loop `for (const [userId, trail])`

#### Type Definitions
- `/packages/shared/src/types/identifiers.ts` Line 5: `export type UserId = string`
- `/packages/shared/src/types/room.ts` Line 22: `Stroke.userId: UserId`
- `/packages/shared/src/types/room.ts` Line 43: `TextBlock.userId: UserId`
- `/packages/shared/src/types/snapshot.ts` Line 41: `StrokeView.userId: string` (should be UserId)
- `/packages/shared/src/types/snapshot.ts` Line 61: `TextView.userId: string` (should be UserId)
- `/packages/shared/src/types/snapshot.ts` Line 95: `EmptySnapshot localUserId: ''`
- `/packages/shared/src/types/awareness.ts` Line 5: `Awareness.userId: UserId`
- `/packages/shared/src/types/awareness.ts` Line 31: `PresenceView.localUserId: UserId`

