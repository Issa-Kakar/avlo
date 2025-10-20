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

## Table of Contents

1. [Current Implementation Analysis](#1-current-implementation-analysis)
2. [Complete Usage Inventory](#2-complete-usage-inventory)
3. [Critical Issues](#3-critical-issues)
4. [Migration Requirements](#4-migration-requirements)
5. [Implementation Plan](#5-implementation-plan)
6. [Testing Strategy](#6-testing-strategy)
7. [Appendices](#7-appendices)

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

#### Test Utilities
13. `/packages/shared/src/test-utils/generators.ts` - **2 occurrences** (test data)
14-19. Test files (6 files) - Multiple occurrences in assertions/mocks

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

## 4. Migration Requirements

### 4.1 Immediate Fix (Dual UserId Bug)

**Objective:** Ensure single source of truth for userId within a tab session.

**Changes Required:**

#### Change 1: RoomDocManager Constructor
```typescript
// File: /client/src/lib/room-doc-manager.ts

// BEFORE (Line 275)
this.userId = ulid(); // User ID for this session

// AFTER
constructor(
  roomId: RoomId,
  options?: RoomDocManagerOptions & { userId?: string }
) {
  this.roomId = roomId;
  this.userId = options?.userId || ulid(); // Accept injected userId
  // ...
}
```

#### Change 2: Canvas.tsx - Pass userId to Manager
```typescript
// File: /client/src/canvas/Canvas.tsx

// Generate userId ONCE
const [userId] = useState(() => {
  let id = sessionStorage.getItem('avlo-user-id');
  if (!id) {
    id = 'user-' + ulid();
    sessionStorage.setItem('avlo-user-id', id);
  }
  return id;
});

// Pass to RoomDocManager (via useRoomDoc hook or registry.acquire())
const roomDoc = useRoomDoc(roomId, { userId }); // Updated signature
```

#### Change 3: Registry/Hook Signature
```typescript
// Update useRoomDoc hook to accept userId
function useRoomDoc(
  roomId: string,
  options?: { userId?: string }
): IRoomDocManager {
  // Pass userId to registry.acquire()
}
```

**Testing:**
- ✅ Undo/redo works for committed strokes
- ✅ Awareness userId matches stroke userId
- ✅ Single userId throughout tab session

### 4.2 Persistent UserId Implementation

**Objective:** Cross-tab, cross-session persistent user identity.

**Storage Strategy:** localStorage (browser-scoped, persistent)

#### New File: `/client/src/lib/persistent-user-id.ts`

```typescript
import { ulid } from 'ulid';
import { generateUserProfile, type UserProfile } from './user-identity';

export interface PersistentUserIdentity {
  userId: string;
  profile: UserProfile;
  createdAt: number;
  lastActiveAt: number;
}

const STORAGE_KEY = 'avlo:user:v1';

export function getOrCreatePersistentUserId(): PersistentUserIdentity {
  // 1. Try localStorage first
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const identity: PersistentUserIdentity = JSON.parse(stored);

      // Update last active timestamp
      identity.lastActiveAt = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));

      return identity;
    }
  } catch (err) {
    console.warn('[PersistentUserId] Failed to load from localStorage:', err);
  }

  // 2. Migrate from old sessionStorage (if exists)
  try {
    const oldId = sessionStorage.getItem('avlo-user-id');
    if (oldId && oldId.startsWith('user-')) {
      const identity: PersistentUserIdentity = {
        userId: oldId,
        profile: generateUserProfile(), // Generate fresh profile
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
      sessionStorage.removeItem('avlo-user-id'); // Clean up

      return identity;
    }
  } catch (err) {
    console.warn('[PersistentUserId] Migration from sessionStorage failed:', err);
  }

  // 3. Generate new persistent identity
  const identity: PersistentUserIdentity = {
    userId: 'user-' + ulid(),
    profile: generateUserProfile(),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch (err) {
    console.error('[PersistentUserId] Failed to persist to localStorage:', err);
    // Continue with in-memory identity (fallback)
  }

  return identity;
}

/**
 * Reset user identity (generate new userId and profile).
 * Useful for "New Identity" button in settings.
 */
export function resetPersistentUserId(): PersistentUserIdentity {
  const identity: PersistentUserIdentity = {
    userId: 'user-' + ulid(),
    profile: generateUserProfile(),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

/**
 * Update user profile (name/color).
 */
export function updateUserProfile(profile: UserProfile): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const identity: PersistentUserIdentity = JSON.parse(stored);
      identity.profile = profile;
      identity.lastActiveAt = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
    }
  } catch (err) {
    console.error('[PersistentUserId] Failed to update profile:', err);
  }
}
```

#### Update Canvas.tsx

```typescript
// File: /client/src/canvas/Canvas.tsx

import { getOrCreatePersistentUserId } from '@/lib/persistent-user-id';

// BEFORE (Lines 190-198)
const [userId] = useState(() => {
  let id = sessionStorage.getItem('avlo-user-id');
  if (!id) {
    id = 'user-' + ulid();
    sessionStorage.setItem('avlo-user-id', id);
  }
  return id;
});

// AFTER
const userIdentity = useMemo(() => getOrCreatePersistentUserId(), []);
const userId = userIdentity.userId;
```

#### Update RoomDocManager

```typescript
// File: /client/src/lib/room-doc-manager.ts

// BEFORE (Lines 275-278)
this.userId = ulid();
this.userProfile = generateUserProfile();

// AFTER
constructor(
  roomId: RoomId,
  options?: RoomDocManagerOptions & {
    userId?: string;
    userProfile?: UserProfile;
  }
) {
  this.roomId = roomId;

  // Accept injected identity from Canvas
  if (options?.userId && options?.userProfile) {
    this.userId = options.userId;
    this.userProfile = options.userProfile;
  } else {
    // Fallback for tests/edge cases
    const identity = getOrCreatePersistentUserId();
    this.userId = identity.userId;
    this.userProfile = identity.profile;
  }

  // ...rest of constructor
}
```

#### Update Canvas Tool Instantiation

```typescript
// File: /client/src/canvas/Canvas.tsx

// Pass persistent userId to manager via registry/hook
const roomDoc = useRoomDoc(roomId, {
  userId: userIdentity.userId,
  userProfile: userIdentity.profile,
});

// Tools automatically receive correct userId (no change needed)
tool = new DrawingTool(
  roomDoc,
  settings,
  activeTool,
  userId, // From userIdentity
  // ...
);
```

### 4.3 Type Definition Updates

#### Update Snapshot Types for Consistency

```typescript
// File: /packages/shared/src/types/snapshot.ts

// BEFORE (Line 41)
export interface StrokeView {
  userId: string;
  // ...
}

// AFTER
export interface StrokeView {
  userId: UserId; // ← Change to UserId type
  // ...
}

// Similarly for TextView (Line 61)
```

#### Update Type Comment

```typescript
// File: /packages/shared/src/types/identifiers.ts

// BEFORE (Line 5)
export type UserId = string; // format: "deviceULID:tabULID"

// AFTER
export type UserId = string; // format: "user-{ULID}" (persistent across sessions)
```

---

## 5. Implementation Plan

### Phase 1: Critical Bug Fix (1-2 hours)

**Goal:** Fix dual userId generation to restore undo/redo functionality.

**Tasks:**
1. ✅ Update RoomDocManager constructor to accept `userId` option
2. ✅ Update Canvas.tsx to pass userId to RoomDocManager
3. ✅ Update registry/hook signature to pass userId
4. ✅ Test undo/redo works for committed strokes
5. ✅ Test awareness userId matches stroke userId

**Files Changed:**
- `/client/src/lib/room-doc-manager.ts` (1 line)
- `/client/src/canvas/Canvas.tsx` (update hook call)
- `/client/src/hooks/useRoomDoc.ts` or registry (signature update)

**Risk:** Low (backwards compatible, optional parameter)

### Phase 2: Persistent UserId (2-4 hours)

**Goal:** Implement localStorage-based persistent user identity.

**Tasks:**
1. ✅ Create `/client/src/lib/persistent-user-id.ts` module
2. ✅ Implement `getOrCreatePersistentUserId()` with localStorage
3. ✅ Add migration from sessionStorage
4. ✅ Add error handling and fallbacks
5. ✅ Update Canvas.tsx to use persistent identity
6. ✅ Update RoomDocManager to accept userProfile
7. ✅ Test cross-tab behavior (same userId in multiple tabs)
8. ✅ Test cross-session persistence (close/reopen browser)

**Files Changed:**
- `/client/src/lib/persistent-user-id.ts` (NEW)
- `/client/src/canvas/Canvas.tsx` (replace userId generation)
- `/client/src/lib/room-doc-manager.ts` (accept userProfile)

**Risk:** Low (localStorage widely supported, fallback to sessionStorage)

### Phase 3: Type Consistency (30 minutes)

**Goal:** Fix type inconsistencies for better type safety.

**Tasks:**
1. ✅ Change `StrokeView.userId` from `string` to `UserId`
2. ✅ Change `TextView.userId` from `string` to `UserId`
3. ✅ Update type comment in `identifiers.ts`
4. ✅ Run TypeScript compiler, fix any new errors

**Files Changed:**
- `/packages/shared/src/types/snapshot.ts` (2 lines)
- `/packages/shared/src/types/identifiers.ts` (1 comment)

**Risk:** Very low (type-only change, no runtime impact)

### Phase 4: Testing & Validation (2-3 hours)

**Goal:** Comprehensive testing of persistent userId behavior.

**Test Cases:**
- [ ] userId persists across page refreshes
- [ ] userId persists across browser restarts
- [ ] Same userId in multiple tabs (cross-tab identity)
- [ ] Undo/redo works across sessions (if Y.Doc persisted)
- [ ] Stroke attribution shows correct creator
- [ ] Text attribution shows correct creator
- [ ] Presence shows single user (not duplicates)
- [ ] Cursor trails persist across reconnects
- [ ] Avatar cluster stable (no flicker on reconnect)
- [ ] Migration from sessionStorage works
- [ ] localStorage quota exceeded handled gracefully
- [ ] Private browsing mode fallback works
- [ ] Cross-browser compatibility (Chrome, Firefox, Safari)
- [ ] Mobile Safari (iOS localStorage restrictions)

**Files Changed:**
- Test files (update generators and assertions)

**Risk:** Low (test-only changes)

### Phase 5: Optional Enhancements (Future)

**Goal:** Additional features leveraging persistent userId.

**Possible Enhancements:**
- [ ] User profile editor (customize name/color)
- [ ] "My Strokes" filter (show only own strokes)
- [ ] Per-user clear board (clear only own strokes)
- [ ] User statistics dashboard (stroke count, colors used)
- [ ] Cross-device sync via auth provider
- [ ] Server-side user accounts

---

## 6. Testing Strategy

### 6.1 Unit Tests

#### Test: Persistent UserId Generation

```typescript
describe('getOrCreatePersistentUserId', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('generates new identity on first call', () => {
    const identity = getOrCreatePersistentUserId();

    expect(identity.userId).toMatch(/^user-[0-9A-Z]{26}$/);
    expect(identity.profile.name).toBeTruthy();
    expect(identity.profile.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(identity.createdAt).toBeCloseTo(Date.now(), -2);
  });

  it('returns same identity on subsequent calls', () => {
    const identity1 = getOrCreatePersistentUserId();
    const identity2 = getOrCreatePersistentUserId();

    expect(identity1.userId).toBe(identity2.userId);
    expect(identity1.profile.name).toBe(identity2.profile.name);
    expect(identity1.profile.color).toBe(identity2.profile.color);
  });

  it('migrates from old sessionStorage format', () => {
    sessionStorage.setItem('avlo-user-id', 'user-01HXYZ123ABC');

    const identity = getOrCreatePersistentUserId();

    expect(identity.userId).toBe('user-01HXYZ123ABC');
    expect(sessionStorage.getItem('avlo-user-id')).toBeNull();
    expect(localStorage.getItem('avlo:user:v1')).toBeTruthy();
  });

  it('handles localStorage unavailable', () => {
    // Mock localStorage.setItem to throw
    const setItemSpy = jest.spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

    const identity = getOrCreatePersistentUserId();

    expect(identity.userId).toBeTruthy(); // Should still return valid ID

    setItemSpy.mockRestore();
  });
});
```

#### Test: RoomDocManager UserId Injection

```typescript
describe('RoomDocManager userId injection', () => {
  it('uses injected userId if provided', () => {
    const customUserId = 'user-custom-12345';
    const manager = new RoomDocManager('test-room', {
      userId: customUserId,
      userProfile: { name: 'Test User', color: '#FF0000' },
    });

    expect(manager.getUserId()).toBe(customUserId);
  });

  it('generates userId if not provided', () => {
    const manager = new RoomDocManager('test-room');

    expect(manager.getUserId()).toMatch(/^user-[0-9A-Z]{26}$/);
  });

  it('uses same userId for awareness and mutations', () => {
    const customUserId = 'user-test-123';
    const manager = new RoomDocManager('test-room', {
      userId: customUserId,
    });

    // Check awareness
    const awareness = manager.yAwareness.getLocalState();
    expect(awareness.userId).toBe(customUserId);

    // Check transaction origin
    let capturedOrigin: string | undefined;
    manager.ydoc.on('beforeTransaction', (tr) => {
      capturedOrigin = tr.origin as string;
    });

    manager.mutate((ydoc) => {
      // Trigger transaction
    });

    expect(capturedOrigin).toBe(customUserId);
  });
});
```

### 6.2 Integration Tests

#### Test: Cross-Tab Identity

```typescript
describe('Cross-Tab Identity', () => {
  it('uses same userId in multiple tabs', async () => {
    // Simulate Tab 1
    const identity1 = getOrCreatePersistentUserId();

    // Simulate Tab 2 (same browser)
    const identity2 = getOrCreatePersistentUserId();

    expect(identity1.userId).toBe(identity2.userId);
    expect(identity1.profile.name).toBe(identity2.profile.name);
  });

  it('shows single user in presence from multiple tabs', async () => {
    // Setup: 2 RoomDocManagers with same userId
    const sharedUserId = 'user-shared-123';
    const manager1 = new RoomDocManager('room-1', { userId: sharedUserId });
    const manager2 = new RoomDocManager('room-1', { userId: sharedUserId });

    // Connect both to same awareness
    // (In reality, this would be through WebSocket, mocked here)

    const presence = manager1.currentSnapshot.presence;

    // Should show only 1 user (the shared identity)
    // Note: In practice, different tabs still have different awareness clientIds
    // This test validates that the APPLICATION-LEVEL userId is consistent
  });
});
```

#### Test: Stroke Attribution Persistence

```typescript
describe('Stroke Attribution', () => {
  it('attributes strokes to correct persistent userId', () => {
    const userId = 'user-persistent-123';
    const manager = new RoomDocManager('test-room', { userId });

    // Commit a stroke
    manager.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const strokes = root.get('strokes') as Y.Array<any>;
      strokes.push([{
        id: 'stroke-1',
        userId: userId,
        // ... other fields
      }]);
    });

    // Read back from snapshot
    const snapshot = manager.currentSnapshot;
    const stroke = snapshot.strokes[0];

    expect(stroke.userId).toBe(userId);
  });

  it('undo/redo works for strokes with matching userId', () => {
    const userId = 'user-test-456';
    const manager = new RoomDocManager('test-room', { userId });

    // Commit stroke
    manager.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const strokes = root.get('strokes') as Y.Array<any>;
      strokes.push([{ id: 'stroke-1', userId }]);
    });

    expect(manager.currentSnapshot.strokes).toHaveLength(1);

    // Undo
    manager.undo();

    expect(manager.currentSnapshot.strokes).toHaveLength(0);

    // Redo
    manager.redo();

    expect(manager.currentSnapshot.strokes).toHaveLength(1);
  });
});
```

### 6.3 E2E Tests

#### Test: Cross-Session Persistence

```typescript
describe('Cross-Session Persistence (E2E)', () => {
  it('maintains userId across page refreshes', async () => {
    // Visit page
    await page.goto('/room/test-123');

    // Get initial userId (extract from awareness or data-testid)
    const initialUserId = await page.evaluate(() => {
      return window.localStorage.getItem('avlo:user:v1');
    });

    expect(initialUserId).toBeTruthy();

    // Refresh page
    await page.reload();

    // Get userId after refresh
    const afterRefreshUserId = await page.evaluate(() => {
      return window.localStorage.getItem('avlo:user:v1');
    });

    expect(afterRefreshUserId).toBe(initialUserId);
  });

  it('maintains userId across browser restarts', async () => {
    // Visit page, get userId
    await page.goto('/room/test-123');
    const userId1 = await page.evaluate(() => {
      const stored = window.localStorage.getItem('avlo:user:v1');
      return JSON.parse(stored!).userId;
    });

    // Close browser (persist localStorage)
    await browser.close();

    // Reopen browser
    browser = await puppeteer.launch();
    page = await browser.newPage();

    // Visit same page
    await page.goto('/room/test-123');
    const userId2 = await page.evaluate(() => {
      const stored = window.localStorage.getItem('avlo:user:v1');
      return JSON.parse(stored!).userId;
    });

    expect(userId2).toBe(userId1);
  });
});
```

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

### Appendix B: Storage Format Comparison

#### Current Format (sessionStorage)

```json
{
  "key": "avlo-user-id",
  "value": "user-01HXYZ123ABCDEFGHIJKLMNOPQ"
}
```

#### Proposed Format (localStorage)

```json
{
  "key": "avlo:user:v1",
  "value": {
    "userId": "user-01HXYZ123ABCDEFGHIJKLMNOPQ",
    "profile": {
      "name": "Swift Fox",
      "color": "#4A90E2"
    },
    "createdAt": 1697654400000,
    "lastActiveAt": 1697740800000
  }
}
```

**Key Benefits:**
- Single source of truth for userId AND profile
- Timestamp tracking for analytics
- Versioned key (`v1`) for future migrations
- JSON structure allows adding fields without breaking changes

### Appendix C: Migration Checklist

#### Pre-Migration
- [ ] Audit complete (this document)
- [ ] Implementation plan reviewed
- [ ] Test strategy defined
- [ ] Backup plan for localStorage failures

#### Phase 1 (Dual UserId Fix)
- [ ] Update RoomDocManager constructor signature
- [ ] Update Canvas userId passing
- [ ] Update registry/hook
- [ ] Run existing undo/redo tests
- [ ] Manual testing: undo/redo works
- [ ] Deploy to staging
- [ ] Monitor error rates

#### Phase 2 (Persistent UserId)
- [ ] Implement `persistent-user-id.ts` module
- [ ] Add unit tests for generation/migration
- [ ] Update Canvas to use persistent identity
- [ ] Update RoomDocManager to accept userProfile
- [ ] Add integration tests for cross-tab behavior
- [ ] Test localStorage quota exceeded
- [ ] Test private browsing mode
- [ ] Deploy to staging
- [ ] Monitor localStorage usage metrics

#### Phase 3 (Type Consistency)
- [ ] Update StrokeView/TextView types
- [ ] Update type comment
- [ ] Run TypeScript compiler
- [ ] Fix any type errors
- [ ] Update test assertions
- [ ] Deploy to staging

#### Phase 4 (Production)
- [ ] All tests passing
- [ ] No new errors in staging
- [ ] Feature flag enabled for 10% users
- [ ] Monitor metrics (undo/redo usage, localStorage errors)
- [ ] Rollout to 100%

### Appendix D: Rollback Plan

**If persistent userId causes issues:**

1. **Immediate Rollback (localStorage failures):**
   - Add try/catch in `getOrCreatePersistentUserId()`
   - Fallback to sessionStorage (current behavior)
   - Log error to monitoring

2. **Partial Rollback (undo/redo broken):**
   - Revert RoomDocManager constructor changes
   - Keep persistent userId for display only
   - Fix undo/redo in separate PR

3. **Full Rollback:**
   - Revert all changes
   - Return to dual userId (with bug)
   - Schedule fix in next sprint

### Appendix E: Future Enhancements

#### Cross-Device Sync (Server-Based UserId)

**Architecture:**
```
┌─────────────────────────────────────────┐
│ Browser A (Desktop)                     │
│  localStorage: { userId: "device-A" }   │
│  Auth Token: "tok_abc123"               │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ Server: User Accounts Table             │
│  userId    authId       devices          │
│  ────────  ──────────  ────────────────  │
│  user-123  tok_abc123  [device-A, ...]   │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ Browser B (Mobile)                      │
│  localStorage: { userId: "device-B" }   │
│  Auth Token: "tok_abc123"               │
└─────────────────────────────────────────┘
```

**Implementation:**
1. Add authentication provider (Clerk, Auth0, etc.)
2. Link anonymous `device-*` userId to auth account
3. Sync profile across devices via API
4. Maintain `device-*` format for local-first operation
5. Upgrade to `auth:{providerId}:{userId}` when authenticated

#### Per-User Clear Board

**Use Case:** User wants to clear only their own strokes, not entire board.

**Implementation:**
```typescript
function clearMyStrokes(userId: string): void {
  roomDoc.mutate((ydoc) => {
    const root = ydoc.getMap('root');
    const strokes = root.get('strokes') as Y.Array<any>;

    // Find indices of user's strokes
    const myIndices: number[] = [];
    strokes.forEach((stroke, idx) => {
      if (stroke.userId === userId) {
        myIndices.push(idx);
      }
    });

    // Delete in reverse order
    myIndices.reverse().forEach(idx => {
      strokes.delete(idx, 1);
    });
  });
}
```

**UI:** Add "Clear My Strokes" button next to "Clear Board".

---

**End of Audit Report**

---

## Summary

This audit identified 47+ occurrences of `userId` across 20 implementation files. The codebase is well-prepared for persistent userId migration, requiring changes to only **3 core files**:

1. `/client/src/lib/persistent-user-id.ts` (NEW)
2. `/client/src/lib/room-doc-manager.ts` (constructor updates)
3. `/client/src/canvas/Canvas.tsx` (replace userId generation)

**Critical finding:** Dual userId generation bug must be fixed immediately to restore undo/redo functionality.

**Migration complexity:** Low - no storage schema changes, no network protocol changes, no breaking changes to rendering or UI.

**Estimated effort:** 4-8 hours total (1-2 hours for bug fix, 2-4 hours for persistent userId, 1-2 hours for testing).

**Recommendation:** Proceed with Phase 1 (dual userId fix) immediately, then Phase 2 (persistent userId) in next sprint.