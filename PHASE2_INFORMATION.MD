## Phase 2: Core Data Layer & Models

Out of scope
Any UI components, canvas work, or **network providers (WS/RTC)** are out of scope. **Local plumbing (WriteQueue/CommandBus)** is in scope. 
Multi-node scaling, auth/permissions, or admin tooling. 

Constraints
- Will use stroke/text configs for data models
UI must not import yjs/providers; expose access only through RoomDocManager + hooks. Snapshots are immutable and never null. 
Authoritative storage is Redis (TTL-based); Postgres is non-authoritative metadata only. 
Store stroke points as number[] in Yjs; create Float32Array only at render time. 
Enforce budgets in WriteQueue.validate: MAX_POINTS_PER_STROKE=10k, encoded update < 128 KB, text ≤ 500 chars. 
UI components must not import Yjs/providers directly; all mutations go through WriteQueue → CommandBus; snapshots are immutable. 
Store numeric arrays in Yjs as number[]; only create Float32Array at render time. 
Command limits: ≤10,000 points per stroke; code ≤200KB; text ≤500 chars; specific server rate limits apply later. 
Snapshot publish loop max 60fps; coalesce updates within ~8–16ms; drop to ~8fps when tab hidden.
Y.Doc({guid:roomId}) must equal resolved roomId; never mutate guid.
Snapshot builder must be O(changes), publish ≤1/rAF, and freeze in dev.
All commands carry idempotencyKey; duplicates discard without side-effects.
Validation guards cover MAX_TOTAL_STROKES and per-command rate limits.

Things to watch out for
Single consumer for yjs.transact; coalesce within a transact; yield if > 8 ms to avoid jank. 
Backpressure: widen micro-batch window to 24–32 ms when queue grows; drop superseded deltas.
Always emit an initial EmptySnapshot; never allow null snapshot. 
Enforce queue backpressure (max ~100 pending) and idempotency to prevent duplicate writes. 
Keep Yjs state-vector–derived svKey stable to avoid spurious re-renders.
Re-entrancy of observers during batch updates.
Publish thrash when micro-batching windows widen; keep ≤32 ms under pressure.
Memory pressure from large arrays; avoid accidental Float32Array retention.

### 2.1 Define TypeScript Types and Interfaces
1. Create shared types file with all data models from Section 4:
   - StrokeId, TextId, SceneIdx type aliases
   - Stroke interface with all required fields
   - TextBlock interface
   - CodeCell and Output interfaces
   - Meta interface with scene_ticks array
2. Define awareness payload structure (ephemeral data)
3. Create device UI state interfaces for localStorage
4. Define command types for WriteQueue pattern
5. Create snapshot interface (immutable view structure)
6. Add validation helper types and guards

### 2.2 Implement RoomDocManager Foundation
1. Create RoomDocManager class skeleton with:
   - Private Y.Doc instance property
   - Private provider references (will be null initially)
   - Current snapshot property (never null - start with EmptySnapshot)
   - Subscription management maps
2. Implement constructor that:
   - Creates Y.Doc with guid matching roomId
   - Initializes EmptySnapshot synchronously
   - Sets up internal event emitters
3. Add destroy method that will handle cleanup (stub for now)
4. Implement subscription methods (return unsubscribe functions):
   - subscribeSnapshot
   - subscribePresence  
   - subscribeRoomStats
5. Create singleton registry to ensure one manager per room

### 2.3 Set Up Yjs Document Structure
1. Initialize Y.Map as document root in RoomDocManager
2. Create Y.Array for strokes with proper typing
3. Create Y.Array for texts
4. Create Y.Map for code cell
5. Create Y.Array for outputs with size enforcement
6. Create Y.Map for meta including scene_ticks array
7. Add helper methods to safely access these structures
8. Important: Store arrays as plain number[], never Float32Array in Yjs

### 2.4 Implement Snapshot Publishing System
1. Create snapshot builder that:
   - Reads current Y.Doc state
   - Generates unique svKey from state vector
   - Creates frozen arrays (Object.freeze in development)
   - Builds immutable snapshot object
2. Set up requestAnimationFrame loop for publishing:
   - Maximum 60 FPS rate limiting
   - Batch multiple Y updates within single frame
   - Coalesce updates within 8-16ms windows
3. Implement dirty tracking to avoid unnecessary publishes
4. Add logic to detect tab visibility and reduce to 8 FPS when hidden
5. Ensure EmptySnapshot is published immediately on creation
6. Persist **last render Snapshot** in IndexedDB **keyed by Yjs state vector (svKey)**. On boot, if `svKey` matches, render that snapshot immediately while providers connect; otherwise skip.

### 2.5 Create WriteQueue and CommandBus
1. Implement WriteQueue class with:
   - Queue data structure with max 100 pending commands
   - Validation method checking room size, mobile status, frame size
   - Backpressure handling when queue exceeds limits
   - Idempotency tracking map
2. Create CommandBus that:
   - Consumes from WriteQueue
   - Wraps each command in single yjs.transact()
   - Applies commands to Y.Doc structures
   - Handles command-specific logic
3. Add command validation for each command type:
   - Size limits (MAX_POINTS_PER_STROKE = 10,000)
   - Content limits (code body ≤ 200KB)
   - Text length limits (500 chars)
4. Implement rate limiting for specific commands (ClearBoard: 1/15s)

**Deliverables:**
- Complete TypeScript type system
- Basic RoomDocManager with subscription system
- Yjs document structure initialized
- Snapshot publishing pipeline
- WriteQueue and CommandBus infrastructure
