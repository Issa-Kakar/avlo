# Stable IDs & Yjs UndoManager Implementation Guide

## Executive Summary
This guide provides a corrected implementation plan for stable user IDs and Yjs UndoManager. The core issue is that Canvas.tsx and RoomDocManager generate different userId formats, breaking undo/redo. The solution creates a UserProfileManager singleton that provides consistent IDs across the application.

## Current Problem Analysis

### ID Generation Mismatch
- **RoomDocManager** (line 268): `this.userId = ulid()` → Plain ULID (e.g., `01HXYZ123ABC`)
- **Canvas.tsx** (line 194): `'user-' + ulid()` → Prefixed ULID (e.g., `user-01HXYZ456DEF`)
- **Impact**: Strokes are stamped with Canvas userId but transactions use RoomDocManager userId as origin
- **Result**: UndoManager cannot track strokes because origins don't match

### Affected Components
```
Canvas.tsx → Tools (DrawingTool, EraserTool, TextTool) → commit with Canvas userId
RoomDocManager → mutate() → ydoc.transact(fn, this.userId) → different origin
```

### UI Component Hierarchy
```
RoomPage.tsx
  └── RoomCanvas (has roomId)
        ├── Canvas
        ├── ToolPanel (receives onToast only, NOT roomId)
        └── useKeyboardShortcuts (already wired for undo/redo)
```

## Implementation Plan

### Step 1: Create UserProfileManager Singleton

**File:** `/client/src/lib/user-profile-manager.ts` (NEW)

```typescript
import { ulid } from 'ulid';
import { generateUserProfile, type UserProfile } from './user-identity';

export interface UserIdentity extends UserProfile {
  userId: string;
}

const STORAGE_KEY = 'avlo:user:v1';

class UserProfileManager {
  private static instance: UserProfileManager;
  private identity: UserIdentity | null = null;
  private listeners = new Set<(identity: UserIdentity) => void>();
  private storageAvailable: boolean = false;

  private constructor() {
    // Test localStorage availability on construction
    this.storageAvailable = this.checkStorageAvailable();
  }

  private checkStorageAvailable(): boolean {
    try {
      const test = '__storage_test__';
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch {
      // localStorage unavailable (private browsing, disabled, etc.)
      return false;
    }
  }

  static getInstance(): UserProfileManager {
    if (!UserProfileManager.instance) {
      UserProfileManager.instance = new UserProfileManager();
    }
    return UserProfileManager.instance;
  }

  /**
   * Get or create stable user identity
   * CRITICAL: Synchronous for use in constructors
   * Handles private browsing and localStorage errors gracefully
   */
  getIdentity(): UserIdentity {
    // Return cached if available
    if (this.identity) {
      return this.identity;
    }

    // Try loading from localStorage (with error handling)
    if (this.storageAvailable) {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          // Validate structure
          if (parsed.userId && parsed.name && parsed.color) {
            this.identity = {
              userId: parsed.userId,
              name: parsed.name,
              color: parsed.color
            };
            return this.identity;
          }
        }
      } catch (err) {
        console.warn('[UserProfileManager] Failed to read from localStorage:', err);
        // Continue to create new identity
      }
    }

    // Create new identity using existing user-identity.ts logic
    const profile = generateUserProfile();
    this.identity = {
      userId: ulid(), // Plain ULID, no prefix
      name: profile.name,
      color: profile.color
    };

    // Try to persist (but don't fail if we can't)
    if (this.storageAvailable) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.identity));
      } catch (err) {
        console.warn('[UserProfileManager] Failed to persist to localStorage:', err);
        // Identity works in memory even if we can't persist
      }
    }

    return this.identity;
  }

  /**
   * Update profile (name/color only, NOT userId)
   */
  updateProfile(updates: Partial<Pick<UserIdentity, 'name' | 'color'>>): void {
    const current = this.getIdentity();
    this.identity = { ...current, ...updates };

    // Try to persist (but don't fail if we can't)
    if (this.storageAvailable) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.identity));
      } catch (err) {
        console.warn('[UserProfileManager] Failed to update localStorage:', err);
      }
    }

    this.notifyListeners();
  }

  /**
   * Subscribe to profile changes
   */
  subscribe(listener: (identity: UserIdentity) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    if (!this.identity) return;
    this.listeners.forEach(listener => listener(this.identity!));
  }

  /**
   * Clear identity (mainly for testing)
   */
  clearIdentity(): void {
    this.identity = null;

    if (this.storageAvailable) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (err) {
        // Ignore errors when clearing
      }
    }
  }
}

// Export singleton instance
export const userProfileManager = UserProfileManager.getInstance();
```

**Key Design Decisions:**
- Uses localStorage (not sessionStorage) for cross-tab consistency when available
- Gracefully handles private browsing and localStorage failures
- Falls back to memory-only storage in private/incognito mode
- Tests localStorage availability on construction to avoid runtime errors
- Imports `generateUserProfile` from existing `user-identity.ts`
- Synchronous `getIdentity()` safe for use in constructors
- Plain ULID format (no 'user-' prefix) for consistency


### Step 2: Update RoomDocManager to Use Singleton

**File:** `/client/src/lib/room-doc-manager.ts`

**2.1 Add import at top:**
```typescript
import { userProfileManager } from './user-profile-manager';
```

**2.2 Remove existing imports (if no longer used elsewhere):**
```typescript
// Remove these if only used for user generation
import { ulid } from 'ulid';
import { generateUserProfile } from './user-identity';
```

**2.3 Update constructor (lines 266-271):**
```typescript
constructor(roomId: RoomId, options?: RoomDocManagerOptions) {
  this.roomId = roomId;

  // Get stable identity from singleton
  const identity = userProfileManager.getIdentity();
  this.userId = identity.userId;
  this.userProfile = {
    name: identity.name,
    color: identity.color
  };

  // Initialize Y.Doc with room GUID
  this.ydoc = new Y.Doc({ guid: roomId });
  // ... rest of constructor
```

### Step 3: Update Canvas.tsx to Use Singleton

**File:** `/client/src/canvas/Canvas.tsx`

**3.1 Add import around line 10:**
```typescript
import { userProfileManager } from '../lib/user-profile-manager';
```

**3.2 Replace userId state (lines 190-198) with:**
```typescript
// Get stable user ID from singleton
const userId = useMemo(() => userProfileManager.getIdentity().userId, []);
```

**3.3 Remove sessionStorage logic completely**

### Step 4: Add Yjs UndoManager to RoomDocManager

**File:** `/client/src/lib/room-doc-manager.ts`

**4.2 Add field to class (around line 141):**
```typescript
private undoManager: Y.UndoManager | null = null;
```

**4.4 Create attachUndoManager method (add after constructor):**
```typescript
/**
 * Attach UndoManager to track local changes
 * CRITICAL: Only call after Y.Doc structures are initialized
 */
private attachUndoManager(): void {
  if (this.undoManager) {
    console.warn('[RoomDocManager] UndoManager already attached');
    return;
  }

  const root = this.getRoot();
  const strokes = root.get('strokes');
  const texts = root.get('texts');

  // Create UndoManager scoped to strokes and texts
  // Only track transactions with our userId as origin
  this.undoManager = new Y.UndoManager([strokes, texts], {
    trackedOrigins: new Set([this.userId]),
    captureTimeout: 500, // Merge rapid changes within 500ms
  });

  console.log(`[RoomDocManager] UndoManager attached for userId: ${this.userId}`);
}
```

**4.5 Find setupArrayObservers call and add attachUndoManager after it:**

Look for this pattern around line 347:
```typescript
// Now that structures exist (either from IDB/WS or freshly initialized),
// it's safe to attach array observers for incremental updates
this.setupArrayObservers();
```

Add after it:
```typescript
// Attach UndoManager after observers are set up
this.attachUndoManager();
```

**4.6 Update IRoomDocManager interface (around line 71-73):**
```typescript
export interface IRoomDocManager {
  // ... existing methods ...
  mutate(fn: (ydoc: Y.Doc) => void): void;
  extendTTL(): void;
  destroy(): void;
  undo(): void;  // NEW
  redo(): void;  // NEW
}
```

**4.7 Implement public undo/redo methods (add after mutate method, around line 960):**
```typescript
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
```

**4.8 Add cleanup in destroy method (look for destroy method around line 1100-1140):**

Find the destroy method and add before final cleanup:
```typescript
// Destroy UndoManager
if (this.undoManager) {
  this.undoManager.destroy();
  this.undoManager = null;
}
```

### Step 5: Create useUndoRedo Hook

**File:** `/client/src/hooks/use-undo-redo.ts` (NEW)

```typescript
import { useCallback } from 'react';
import { useRoomDoc } from './use-room-doc';
import type { RoomId } from '@avlo/shared';

export interface UndoRedoActions {
  undo: () => void;
  redo: () => void;
}

/**
 * Hook to access undo/redo functionality for a room
 */
export function useUndoRedo(roomId: RoomId): UndoRedoActions {
  const roomDoc = useRoomDoc(roomId);

  const undo = useCallback(() => {
    roomDoc.undo();
  }, [roomDoc]);

  const redo = useCallback(() => {
    roomDoc.redo();
  }, [roomDoc]);

  return { undo, redo };
}
```

### Step 6: Wire Undo/Redo in RoomPage

**File:** `/client/src/pages/RoomPage.tsx`

**6.1 Add import (around line 25):**
```typescript
import { useUndoRedo } from '../hooks/use-undo-redo';
```

**6.2 Update RoomCanvas component - Replace placeholder undo/redo (lines 34-67):**

Find the RoomCanvas function and update:
```typescript
function RoomCanvas({ roomId }: RoomCanvasProps) {
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const { showToast } = useToast();
  const clearScene = useClearScene(roomId);
  const { undo, redo } = useUndoRedo(roomId); // NEW

  const handleClear = () => {
    // ... existing clear logic ...
  };

  const handleInvite = async () => {
    // ... existing invite logic ...
  };

  // Replace the placeholder undo/redo handlers
  const handleUndo = () => {
    undo();
    // Optionally: showToast('Undo');
  };

  const handleRedo = () => {
    redo();
    // Optionally: showToast('Redo');
  };

  // Keyboard shortcuts - already wired correctly
  useKeyboardShortcuts({
    onClear: handleClear,
    onUndo: handleUndo,  // Now uses real undo
    onRedo: handleRedo,  // Now uses real redo
    onToast: showToast,
  });
```

**6.3 Pass undo/redo to ToolPanel (around line 134):**
```typescript
<ToolPanel
  onToast={showToast}
  onUndo={handleUndo}  // NEW
  onRedo={handleRedo}  // NEW
/>
```

### Step 7: Update ToolPanel to Accept Undo/Redo Callbacks

**File:** `/client/src/pages/components/ToolPanel.tsx`

**7.1 Update interface (around line 22):**
```typescript
interface ToolPanelProps {
  onToast?: (message: string) => void;
  onUndo?: () => void;  // NEW
  onRedo?: () => void;  // NEW
}
```

**7.2 Update function signature (around line 26):**
```typescript
export function ToolPanel({ onToast, onUndo, onRedo }: ToolPanelProps) {
```

**7.3 Update undo/redo buttons (around lines 253-258):**
```typescript
<div className="undo-redo-compact">
  <button
    className="undo-btn"
    aria-label="Undo"
    onClick={onUndo}  // Changed from () => onToast?.('UNDO')
  >
    <IconUndo className="undo-icon" />
  </button>
  <button
    className="redo-btn"
    aria-label="Redo"
    onClick={onRedo}  // Changed from () => onToast?.('REDO')
  >
    <IconRedo className="redo-icon" />
  </button>
</div>
```

## Critical Implementation Notes

### Singleton Pattern
- UserProfileManager ensures ONE identity across entire app
- localStorage provides cross-tab consistency
- Synchronous getIdentity() safe for constructor usage

### ID Format Consistency
- All components now use plain ULID (no 'user-' prefix)
- Transaction origin matches stroke userId
- UndoManager can properly track changes

### UndoManager Lifecycle
1. Attached AFTER Y.Doc structures initialized
2. Tracks ONLY transactions with matching userId origin
3. Destroyed properly in cleanup
4. Session-only (not persistent across refreshes)

### Per-User Undo/Redo Behavior
- **Same user, multiple tabs**: All tabs share the same userId from localStorage
- **Example**: Draw in Tab A → Switch to Tab B → Undo in Tab B → Removes stroke from Tab A
- **This is intentional**: We just don't care


### Component Wiring
- RoomCanvas owns roomId and undo/redo logic
- Passes callbacks down to ToolPanel
- Keyboard shortcuts already properly integrated

## Transaction Flow

```
DrawingTool.commit()
  → roomDoc.mutate(fn)
  → ydoc.transact(fn, this.userId)  // Origin matches stroke.userId
  → UndoManager tracks it (origin in trackedOrigins)
```

## Future Enhancement

This implementation enables future "Clear Mine" feature:
```typescript
clearMyStrokes(): void {
  this.mutate((ydoc) => {
    const root = ydoc.getMap('root');
    const strokes = root.get('strokes') as Y.Array<any>;
    const texts = root.get('texts') as Y.Array<any>;

    // Collect indices where userId matches
    const strokeIndices = [];
    const textIndices = [];

    strokes.forEach((stroke, idx) => {
      if (stroke.userId === this.userId) strokeIndices.push(idx);
    });

    texts.forEach((text, idx) => {
      if (text.userId === this.userId) textIndices.push(idx);
    });

    // Delete in reverse order to preserve indices
    strokeIndices.reverse().forEach(idx => strokes.delete(idx, 1));
    textIndices.reverse().forEach(idx => texts.delete(idx, 1));
  });
}
```

## Edge Cases Handled

1. **Fresh Browser**: New identity created and persisted
2. **Corrupted localStorage**: Falls back to creating new identity
3. **Private Browsing**: Works without crashes (memory-only storage)
4. **localStorage Disabled**: Falls back to memory-only identity
5. **Storage Quota Exceeded**: Gracefully falls back to memory
6. **Safari Private Mode**: No QuotaExceededError crashes
7. **Multiple Tabs**: Same userId across all tabs, each tab can undo any of that user's actions. We intentionally do not care about this
8. **Pre-init Writes**: Deferred by existing mutate() guards
9. **Component Unmount**: Proper cleanup via destroy()

## Summary

This implementation provides stable user IDs across the application and enables per-user undo/redo. The key insight is using a singleton UserProfileManager to ensure consistency between Canvas.tsx and RoomDocManager, allowing Yjs UndoManager to properly track changes by matching transaction origins with stroke userIds.