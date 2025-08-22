# Phase 2.3: Set Up Yjs Document Structure - Implementation Instructions

## 📖 Context: Why Phase 2.2→2.3 Migration Is Necessary

The project uses a **phased migration strategy**:

- **Phase 2.2**: Allowed cached Y structure references as a **temporary stopgap** to quickly fix structure issues and keep snapshots working
- **Phase 2.3**: Enforces **proper boundaries** by removing ALL cached references and requiring access through private helpers
- **This is intentional**: Phase 2.2 was designed to be a quick fix, Phase 2.3 enforces the correct architecture

The `new_prompt.md` analysis revealed that Phase 2.2's instructions explicitly told us to cache references (`this.yMeta = root.get('meta')`), which was OK for that phase. Now Phase 2.3 requires removing ALL of these cached references to enforce proper encapsulation before we add the publishing system in Phase 2.4.

## 🚨 CRITICAL: Phase 2.2 Fixes Required FIRST

### ⚠️ IMPORTANT: Fix These Phase 2.2 Issues Before Proceeding

The current implementation in `room-doc-manager.ts` has critical violations from Phase 2.2 that MUST be fixed before implementing Phase 2.3:

#### 1. **REMOVE Cached Y Structure References (Lines 69-73, 144-149)**

```typescript
// ❌ WRONG - These cached fields MUST be removed:
private readonly yStrokes: Y.Array<Stroke>;
private readonly yTexts: Y.Array<TextBlock>;
private readonly yCode: Y.Map<unknown>;
private readonly yOutputs: Y.Array<Output>;
private readonly yMeta: Y.Map<unknown>;

// ❌ WRONG - These assignments MUST be removed (lines 144-149):
this.yMeta = this.yRoot.get('meta') as Y.Map<unknown>;
this.yStrokes = this.yRoot.get('strokes') as Y.Array<Stroke>;
// ... etc
```

**Why**: Phase 2.2 allowed these as a temporary stopgap, but Phase 2.3 requires NO caching. ALL access must go through private helper methods.

#### 2. **REMOVE Phase 2.4 Code from Constructor (Lines 154-161)**

```typescript
// ❌ WRONG - These belong to Phase 2.4, not 2.2/2.3:
this.setupObservers();
this.setupVisibilityHandling();
this.startPublishLoop();
```

**Why**: Phase 2.3 is ONLY about structures. Publishing, observers, and visibility handling are Phase 2.4 concerns.

#### 3. **FIX buildSnapshot() to Stop Using Cached References**

```typescript
// ❌ WRONG (line 391):
const sceneTicks = (this.yMeta.get('scene_ticks') as Y.Array<number>)?.toArray() || [];

// ❌ WRONG (lines 395-396):
const strokes = this.yStrokes.toArray();
const texts = this.yTexts.toArray();
```

**Why**: These use cached references. Must be replaced with helper method calls.

#### 4. **REMOVE the yRoot Field (Line 66)**

```typescript
// ❌ WRONG - Even yRoot shouldn't be cached:
private readonly yRoot: Y.Map<unknown>;
```

**Why**: ALL Y structures must be accessed through helpers, including the root.

### ✅ Summary of Phase 2.2→2.3 Migration

1. **Phase 2.2 allowed**: Cached references as a quick fix to get structures working
2. **Phase 2.3 requires**: Complete removal of ALL cached references, access only through private helpers
3. **Constructor changes**: Remove observer/publish setup (Phase 2.4), keep only structure initialization
4. **This is intentional**: Phase 2.2 was a stopgap, Phase 2.3 enforces proper boundaries

### 📝 What SHOULD Remain from Phase 2.2

These parts are CORRECT and should be kept:

- ✅ `Y.Doc({ guid: roomId })` creation
- ✅ Structure initialization under root (lines 113-142)
- ✅ EmptySnapshot initialization (line 152)
- ✅ Subscription methods (subscribeSnapshot, subscribePresence, subscribeRoomStats)
- ✅ Destroy method with proper cleanup

### 🔄 Quick Migration Checklist

```bash
# Verify all cached refs are removed:
grep -n "private readonly y[A-Z]" room-doc-manager.ts  # Should return nothing after fix

# Verify no direct Y structure access in buildSnapshot:
grep -n "this\.y[A-Z]" room-doc-manager.ts  # Should return nothing after fix

# Verify Phase 2.4 code removed from constructor:
grep -n "setupObservers\|setupVisibility\|startPublishLoop" room-doc-manager.ts  # Only method definitions should remain
```

---

## ⚠️ CRITICAL CONTEXT

- **Phase 2.1-2.2 are COMPLETE**: TypeScript types defined, RoomDocManager skeleton exists with Y.Doc ownership, immutable snapshots, and subscription system
- **Phase 2.2 has issues**: Cached Y structure references that violate Phase 2.3 requirements
- **Phase 2.3 is PARTIALLY IMPLEMENTED**: Basic Yjs structures are initialized in constructor (lines 113-149 of room-doc-manager.ts) but critical pieces are missing
- **THIS DOCUMENT**: Provides detailed instructions to FIX Phase 2.2 issues and COMPLETE Phase 2.3 properly

## 🎯 Phase 2.3 Objectives

1. Properly initialize and organize Y.Map as document root
2. Create all required Y structures (strokes, texts, code, outputs, meta)
3. **Add PRIVATE helper methods for safe internal access (NEVER expose Y structures)**
4. **Enforce size limits on outputs array**
5. Initialize structures before any provider attachment (Phase 4)
6. Store arrays as plain `number[]`, NEVER Float32Array

## 🚨 CRITICAL CONSTRAINTS (from OVERVIEW.MD & PROMPT.MD)

- **ENCAPSULATION**: Helper methods are PRIVATE - NEVER expose Y structures to external code
- **NO CACHING**: Do NOT cache Y structure references - always access via helpers
- **Y.Doc GUID**: Must equal roomId and NEVER be mutated
- **Array Storage**: ALWAYS store as `number[]` in Yjs, NEVER Float32Array
- **Root Structure**: ALL data MUST be under a root Y.Map
- **Scene Management**: scene_ticks is append-only and excluded from undo
- **Output Limits** (from shared config):
  - Max outputs: `TEXT_CONFIG.MAX_OUTPUTS_COUNT` (default: 10)
  - Each output ≤ `TEXT_CONFIG.MAX_OUTPUT_BYTES_PER_RUN` (default: 10KB)
  - Total outputs ≤ `TEXT_CONFIG.MAX_TOTAL_OUTPUT_BYTES` (default: 128KB)
- **Phase Boundaries**: Phase 2.3 ONLY sets up structures - NO observers/publish loop

## 📦 REQUIRED IMPORTS FROM SHARED CONFIG

```typescript
// Import these from @avlo/shared at the top of room-doc-manager.ts
import {
  ROOM_CONFIG, // For room size limits
  STROKE_CONFIG, // For stroke/point limits
  TEXT_CONFIG, // For text and output limits
  isRoomReadOnly, // Utility function for read-only check
} from '@avlo/shared';

// Key constants you'll use:
// - ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES (10MB cap)
// - TEXT_CONFIG.MAX_OUTPUT_BYTES_PER_RUN (10KB per output)
// - TEXT_CONFIG.MAX_OUTPUTS_COUNT (10 outputs max)
// - TEXT_CONFIG.MAX_TOTAL_OUTPUT_BYTES (128KB total)
// - TEXT_CONFIG.MAX_TEXT_LENGTH (500 chars)
// - TEXT_CONFIG.MAX_CODE_BODY_BYTES (200KB)
// - STROKE_CONFIG.MAX_POINTS_PER_STROKE (10,000)
// - STROKE_CONFIG.MAX_TOTAL_STROKES (5,000)
```

## 📋 CURRENT STATE ANALYSIS

### ✅ What's Already Done (lines 113-149)

```typescript
// Root Y.Map is created
this.yRoot = this.ydoc.getMap('root');

// Structures are initialized under root in transaction
this.ydoc.transact(() => {
  // meta, strokes, texts, code, outputs all created
});

// References stored
this.yMeta = this.yRoot.get('meta') as Y.Map<unknown>;
// ... etc
```

### ❌ What's Missing/Wrong

1. **No helper methods** for safe access (getRoot, getMeta, getStrokes, etc.)
2. **No output size enforcement** when adding to outputs array
3. **No scene tracking** for current scene calculation
4. **No validation** of structure integrity
5. **Canvas reference** in meta not properly typed/handled
6. **No proper typing** for Y structures (using `unknown`)

## 📝 IMPLEMENTATION STEPS

### Step 1: Add Proper Type Definitions and Import Config

Import the shared config and create internal type definitions for Y structures:

```typescript
// Import shared config at the top of room-doc-manager.ts
import { ROOM_CONFIG, STROKE_CONFIG, TEXT_CONFIG, isRoomReadOnly } from '@avlo/shared';

// Add these type aliases after imports - internal use only
// CRITICAL: Y.Map's generic parameter doesn't define the value shape
// Use Y.Map<unknown> and cast when accessing specific properties
type YMeta = Y.Map<unknown>;
type YStrokes = Y.Array<Stroke>;
type YTexts = Y.Array<TextBlock>;
type YCode = Y.Map<unknown>;
type YOutputs = Y.Array<Output>;
type YSceneTicks = Y.Array<number>;
```

### Step 2: Add PRIVATE Helper Methods for Internal Access Only

Add these PRIVATE methods to the RoomDocManagerImpl class:

```typescript
// Import Y at the top of the file
import * as Y from 'yjs';

// CRITICAL: These are PRIVATE helpers for internal use only
// NEVER expose these to external code or cache their return values
// Each call must go through the helper to ensure encapsulation

private getRoot(): Y.Map<unknown> {
  return this.ydoc.getMap('root');
}

private getMeta(): YMeta {
  const meta = this.getRoot().get('meta');
  if (!(meta instanceof Y.Map)) {
    throw new Error('Meta structure corrupted');
  }
  return meta as YMeta;
}

private getSceneTicks(): YSceneTicks {
  const meta = this.getMeta();
  const ticks = meta.get('scene_ticks');
  if (!(ticks instanceof Y.Array)) {
    throw new Error('Scene ticks structure corrupted');
  }
  return ticks as YSceneTicks;
}

private getStrokes(): YStrokes {
  const strokes = this.getRoot().get('strokes');
  if (!(strokes instanceof Y.Array)) {
    throw new Error('Strokes structure corrupted');
  }
  return strokes as YStrokes;
}

private getTexts(): YTexts {
  const texts = this.getRoot().get('texts');
  if (!(texts instanceof Y.Array)) {
    throw new Error('Texts structure corrupted');
  }
  return texts as YTexts;
}

private getCode(): YCode {
  const code = this.getRoot().get('code');
  if (!(code instanceof Y.Map)) {
    throw new Error('Code structure corrupted');
  }
  return code as YCode;
}

private getOutputs(): YOutputs {
  const outputs = this.getRoot().get('outputs');
  if (!(outputs instanceof Y.Array)) {
    throw new Error('Outputs structure corrupted');
  }
  return outputs as YOutputs;
}

// Helper to get current scene
private getCurrentScene(): number {
  const sceneTicks = this.getSceneTicks();
  return sceneTicks.length;
}
```

### Step 3: Fix Initialization with Proper Structure

Replace current initialization (lines 113-149) with:

```typescript
private initializeYjsStructures(): void {
  this.ydoc.transact(() => {
    const root = this.ydoc.getMap('root');

    // Initialize meta if not present
    if (!root.has('meta')) {
      const meta = new Y.Map();
      const sceneTicks = new Y.Array<number>();
      meta.set('scene_ticks', sceneTicks);
      // Canvas reference is optional per OVERVIEW.MD
      // meta.set('canvas', { baseW: 1920, baseH: 1080 }); // Optional
      root.set('meta', meta);
    }

    // Initialize strokes array
    if (!root.has('strokes')) {
      root.set('strokes', new Y.Array<Stroke>());
    }

    // Initialize texts array
    if (!root.has('texts')) {
      root.set('texts', new Y.Array<TextBlock>());
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
      root.set('outputs', new Y.Array<Output>());
    }
  }, 'init'); // Origin for debugging
}
```

### Step 4: Add Output Size Enforcement

Create a method to safely add outputs with size limits:

```typescript
private addOutput(output: Output): void {
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
```

### Step 5: Update buildSnapshot to Use Helper Methods

Update the buildSnapshot method to use the new helpers:

```typescript
private buildSnapshot(): Snapshot {
  // Get current state vector for svKey
  const stateVector = Y.encodeStateVector(this.ydoc);
  const svKey = btoa(String.fromCharCode(...stateVector));

  // Use helper to get current scene
  const currentScene = this.getCurrentScene();

  // Build stroke views using helper (filter by current scene)
  const strokes = this.getStrokes()
    .toArray()
    .filter((s) => s.scene === currentScene)
    .map((s) => ({
      id: s.id,
      points: s.points, // CRITICAL: Include points for renderer to build Float32Array
      polyline: null, // Float32Array created at render time only from points
      style: {
        color: s.color,
        size: s.size,
        opacity: s.opacity,
        tool: s.tool,
      },
      bbox: s.bbox,
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
    }));

  // Build presence view (stub for Phase 2.3)
  const presence: PresenceView = {
    users: new Map(),
    localUserId: '',
  };

  // Build spatial index (stub for Phase 2.3)
  const spatialIndex = { _tree: null };

  // Build view transform (identity for Phase 2.3)
  const view: ViewTransform = {
    worldToCanvas: (x: number, y: number) => [x, y],
    canvasToWorld: (x: number, y: number) => [x, y],
    scale: 1,
    pan: { x: 0, y: 0 },
  };

  // Build metadata
  const meta: SnapshotMeta = {
    cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
    readOnly: false,
    bytes: undefined,
    expiresAt: undefined,
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
    createdAt: Date.now(),
  };

  // Freeze entire snapshot in development
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
    return Object.freeze(snapshot);
  }

  return snapshot;
}
```

### Step 6: Add Validation Method

Add a method to validate structure integrity:

```typescript
private validateStructure(): boolean {
  try {
    const root = this.getRoot();

    // Check all required structures exist
    if (!root.has('meta')) return false;
    if (!root.has('strokes')) return false;
    if (!root.has('texts')) return false;
    if (!root.has('code')) return false;
    if (!root.has('outputs')) return false;

    // Validate meta structure
    const meta = this.getMeta();
    if (!meta.has('scene_ticks')) return false;

    // Validate scene_ticks is array
    const sceneTicks = meta.get('scene_ticks');
    if (!(sceneTicks instanceof Y.Array)) return false;

    // Validate code structure
    const code = this.getCode();
    if (!code.has('lang')) return false;
    if (!code.has('body')) return false;
    if (!code.has('version')) return false;

    return true;
  } catch {
    return false;
  }
}
```

### Step 7: Update Constructor (Phase 2.3 ONLY)

Update the constructor to initialize structures ONLY (no observers/publish loop - those are Phase 2.4):

```typescript
constructor(roomId: RoomId) {
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

  // PHASE 2.3 STOPS HERE - Constructor is DONE

  // ❌ DO NOT add these (they belong to Phase 2.4):
  // this.setupObservers();          // Phase 2.4
  // this.setupVisibilityHandling(); // Phase 2.4
  // this.startPublishLoop();        // Phase 2.4

  // ❌ DO NOT cache Y structure references:
  // this.yStrokes = ...             // WRONG
  // this.yMeta = ...                // WRONG

  // ✅ Always access through helper methods
}
```

## 🧪 TESTING REQUIREMENTS

### Unit Tests to Add

1. **Structure Initialization**
   - Verify all Y structures are created under root
   - Verify scene_ticks starts empty
   - Verify code cell has default values

2. **Helper Methods**
   - Test each getter returns correct Y structure type
   - Test error handling for corrupted structures
   - Test getCurrentScene returns correct value

3. **Output Enforcement**
   - Test single output size limit (`TEXT_CONFIG.MAX_OUTPUT_BYTES_PER_RUN`)
   - Test max outputs count (`TEXT_CONFIG.MAX_OUTPUTS_COUNT`)
   - Test total size limit (`TEXT_CONFIG.MAX_TOTAL_OUTPUT_BYTES`)
   - Test oldest removal when limits exceeded

4. **Data Integrity**
   - Verify arrays store as number[], not Float32Array
   - Verify scene assignment for strokes/texts
   - Verify structure validation catches corruption

### Integration Tests (Phase 2.3 Focus)

1. **Structure Integrity**
   - Verify all structures maintain correct shape after initialization
   - Test that helper methods always return valid Y structures
   - Ensure no direct Y structure references leak

2. **Snapshot Building Preparation**
   - Verify helper methods work correctly for snapshot building
   - Verify no Float32Array stored in Y structures
   - Confirm scene filtering logic is correct

Note: Provider compatibility tests (y-indexeddb, y-websocket) belong to Phase 4

## ⚠️ COMMON PITFALLS TO AVOID

1. **DO NOT store Float32Array in Yjs** - Always use number[]
2. **DO NOT cache Y structure references** - Always call helpers for each access
3. **DO NOT expose helper methods publicly** - They must remain private
4. **DO NOT include Phase 2.4 concerns** - No observers, visibility, or publish loop
5. **DO NOT forget scene assignment** - Strokes/texts need scene at commit
6. **DO NOT ignore output limits** - Enforce all three limits
7. **DO NOT mutate Y.Doc guid** - It must always equal roomId
8. **DO NOT create structures outside root** - Everything under root Y.Map
9. **DO NOT forget to use transactions** - Wrap all mutations in ydoc.transact()
10. **DO NOT forget to include points in snapshot** - Renderer needs points to build Float32Array
11. **DO NOT hard-code constants** - Always use shared config imports (ROOM_CONFIG, STROKE_CONFIG, TEXT_CONFIG)

## 🔍 VERIFICATION CHECKLIST

Before marking Phase 2.3 complete, ensure:

- [ ] Root Y.Map contains all required structures (meta, strokes, texts, code, outputs)
- [ ] Helper methods are PRIVATE and never exposed publicly
- [ ] Helper methods are used for ALL Y structure access (no cached references)
- [ ] Output size enforcement is working (using TEXT_CONFIG limits)
- [ ] getCurrentScene() returns correct value from scene_ticks.length
- [ ] Structure validation method exists and checks all required fields
- [ ] All arrays stored as number[], never Float32Array
- [ ] Scene_ticks is initialized as empty Y.Array<number>
- [ ] Code cell has default values (lang='javascript', body='', version=0)
- [ ] Constructor ONLY initializes structures (no observers/publish loop)
- [ ] EmptySnapshot is created in constructor (never null)
- [ ] Points field IS included in snapshot structure (renderer needs it)
- [ ] Tests pass for structure initialization
- [ ] Tests pass for output limits enforcement
- [ ] NO provider tests included (those are Phase 4)

## 📊 Success Metrics

Phase 2.3 is complete when:

1. All Y structures properly initialized under root
2. Helper methods provide safe access
3. Output limits enforced (using TEXT_CONFIG constants)
4. Scene tracking works correctly
5. No Float32Arrays stored in Yjs
6. All tests pass
7. Structure validation catches corruption
8. Snapshot building uses helpers consistently

## 🔄 Dependencies

### What Phase 2.3 Enables

- **Phase 2.4**: Snapshot publishing can read from properly structured Y.Doc
- **Phase 2.5**: WriteQueue/CommandBus can modify Y structures safely
- **Phase 3**: Canvas can render from well-structured snapshots
- **Phase 4**: Providers can sync properly structured documents

### What Phase 2.3 Requires

- **Phase 2.1-2.2**: TypeScript types and RoomDocManager skeleton (COMPLETE)
- **Shared types**: Command, Stroke, TextBlock, etc. (COMPLETE)

## 📚 Reference Documentation

- **OVERVIEW.MD Section 4.1**: Yjs Document Logical Structure
- **OVERVIEW.MD Section 3**: RoomDocManager Model
- **CLAUDE.md**: Schema helpers requirement
- **packages/shared/src/types/room.ts**: Data structure definitions
- **packages/shared/src/config.ts**: Size limits and constants

## ⚠️ FINAL CRITICAL REMINDERS

### Architecture Principles (MUST FOLLOW)

1. **ENCAPSULATION IS ABSOLUTE**: Helper methods are private implementation details
2. **NO REFERENCE LEAKING**: Never return Y.\* objects from any method
3. **NO CACHING**: Each access must go through helpers to maintain boundaries
4. **PHASE SEPARATION**: Phase 2.3 is ONLY structures - no publish loop/observers

### Common Violations to Avoid

- ❌ `this.yStrokes = this.getStrokes()` - WRONG: caches reference
- ❌ `public getStrokes(): YStrokes` - WRONG: exposes Y structure
- ❌ Missing `points: s.points` in snapshot - WRONG: renderer can't build Float32Array
- ❌ `this.startPublishLoop()` in constructor - WRONG: Phase 2.4 concern

### Correct Patterns

- ✅ Always call `this.getStrokes()` when needed
- ✅ Keep all helper methods `private`
- ✅ Snapshot contains only contract-defined fields
- ✅ Constructor only initializes structures + EmptySnapshot

## 📋 IMPLEMENTATION SEQUENCE

### Order of Operations (MUST follow this sequence):

1. **First: Remove ALL cached Y structure fields** (lines 66, 69-73)
2. **Second: Remove cached assignments** (lines 144-149)
3. **Third: Add private helper methods** (getRoot, getMeta, getStrokes, etc.)
4. **Fourth: Update buildSnapshot()** to use helpers instead of cached refs
5. **Fifth: Remove Phase 2.4 code** from constructor (lines 154-161)
6. **Sixth: Add output size enforcement** (addOutput method)
7. **Seventh: Add structure validation** (validateStructure method)
8. **Finally: Run tests** and verify with grep commands

### Test Commands After Implementation:

```bash
# These should all return NO results after fixes:
grep -n "private readonly y[A-Z]" room-doc-manager.ts
grep -n "this\.y[A-Z]" room-doc-manager.ts
grep -n "this\.yRoot\." room-doc-manager.ts

# This should only show method definitions, not constructor calls:
grep -n "setupObservers\|setupVisibility\|startPublishLoop" room-doc-manager.ts

# Run tests to verify everything works:
npm test -- room-doc-manager
```

---

**Agent Instructions**: Follow these steps sequentially. Test after each major change. Use the verification checklist to ensure completeness. Do not proceed to Phase 2.4 until all items are checked.
