# Phase 2.4 & 2.5: Critical Code Snippets

## ⚠️ CRITICAL: These exact patterns MUST be followed

## 🔴 TOP PRIORITY: Scene Capture Consistency

**CRITICAL BUG TO AVOID:** Using `currentScene` instead of captured scene. This breaks causal consistency in distributed systems.

**RULE:** Scene MUST be captured at interaction start (pointer-down) and that SAME scene value MUST be used at commit time, even if ClearBoard happens during the gesture.

```typescript
// ❌ WRONG - NEVER DO THIS
case 'DrawStrokeCommit': {
  const currentScene = helpers.getCurrentScene(); // ❌ WRONG
  strokes.push([{ scene: currentScene, ... }]);  // ❌ WRONG
}

// ✅ CORRECT - ALWAYS DO THIS
case 'DrawStrokeCommit': {
  strokes.push([{ scene: cmd.scene, ... }]);  // ✅ Use captured scene from command
}
```

### 1. Constructor Initialization Order (EXACT)

```typescript
constructor(roomId: RoomId) {
  this.roomId = roomId;
  
  // 1. Create Y.Doc with guid matching roomId (NEVER change)
  this.ydoc = new Y.Doc({ guid: roomId });
  
  // 2. Initialize Yjs structures (Phase 2.3)
  this.initializeYjsStructures();
  
  // 3. Validate structure
  if (!this.validateStructure()) {
    throw new Error('Failed to initialize Y.Doc structure');
  }
  
  // 4. CRITICAL: Initialize with EmptySnapshot (NEVER null)
  this._currentSnapshot = createEmptySnapshot();
  
  // 5. Phase 2.4: Setup snapshot publishing (NO await)
  this.initSnapshotCache(); // Async but don't await
  this.setupObservers();
  this.setupVisibilityHandling();
  this.startPublishLoop();
  
  // 6. Phase 2.5: Setup write pipeline
  this.setupWritePipeline();
}
```

### 2. Y.Doc Observer Pattern (EXACT)

```typescript
private setupObservers(): void {
  // CRITICAL: Use 'update' event, NOT deep observe
  this.ydoc.on('update', this.handleYDocUpdate.bind(this));
  
  // Store bound handler for cleanup
  this.cleanupHandlers.push(() => {
    this.ydoc.off('update', this.handleYDocUpdate);
  });
}

private handleYDocUpdate = (update: Uint8Array, origin: any): void => {
  // ONLY mark dirty, don't publish immediately
  this.publishState.isDirty = true;
  
  // Optional: track for debugging
  if (process.env.NODE_ENV === 'development') {
    console.log('[Y.Doc] Update from origin:', origin);
  }
};
```

### 3. RAF Loop with Proper Timing (EXACT)

```typescript
private startPublishLoop(): void {
  const loop = () => {
    const now = performance.now();
    
    // Calculate minimum interval based on tab visibility
    const minInterval = this.publishState.isHidden 
      ? 125    // 8 FPS for hidden tab
      : 16.67; // 60 FPS for active tab
    
    // Check if enough time has passed
    const timeSinceLastPublish = now - this.publishState.lastPublishTime;
    
    if (this.publishState.isDirty && timeSinceLastPublish >= minInterval) {
      const startTime = performance.now();
      
      // Build and publish
      this.publishSnapshot();
      
      // Track timing for adaptive batching
      const publishTime = performance.now() - startTime;
      this.publishState.publishWorkMs = publishTime;
      this.publishState.lastPublishTime = now;
      this.publishState.isDirty = false;
      
      // Adapt batch window based on work time
      if (publishTime > 8) {
        // Expand window if slow
        this.publishState.batchWindow = Math.min(
          PERFORMANCE_CONFIG.MICRO_BATCH_MAX_MS,
          this.publishState.batchWindow * 1.5
        );
      } else if (publishTime < 4 && this.publishState.batchWindow > 16) {
        // Contract window if fast
        this.publishState.batchWindow = Math.max(
          PERFORMANCE_CONFIG.MICRO_BATCH_MIN_MS,
          this.publishState.batchWindow * 0.8
        );
      }
    }
    
    // CRITICAL: Continue loop
    this.publishState.rafId = requestAnimationFrame(loop);
  };
  
  // Start the loop
  this.publishState.rafId = requestAnimationFrame(loop);
}
```

### 4. svKey Generation (EXACT)

```typescript
private buildSnapshot(): Snapshot {
  // CRITICAL: svKey from state vector ONLY
  const stateVector = Y.encodeStateVector(this.ydoc);
  const svKey = btoa(String.fromCharCode(...stateVector));
  
  // Get current scene using helper
  const currentScene = this.getCurrentScene();
  
  // Build strokes - FILTER by scene
  const strokes = this.getStrokes()
    .toArray()
    .filter((s) => s.scene === currentScene) // CRITICAL: Filter by scene
    .map((s) => ({
      id: s.id,
      points: s.points, // KEEP as number[], NOT Float32Array
      polyline: null as unknown as Float32Array | null, // Render creates this
      style: {
        color: s.color,
        size: s.size,
        opacity: s.opacity,
        tool: s.tool,
      },
      bbox: s.bbox,
    }));
  
  // Similar for texts...
  
  // CRITICAL: Freeze in development
  if (process.env.NODE_ENV === 'development') {
    Object.freeze(strokes);
    strokes.forEach(s => Object.freeze(s));
    // ... freeze other arrays
  }
  
  const snapshot: Snapshot = {
    svKey, // MUST be from state vector
    scene: currentScene,
    strokes,
    texts,
    presence,
    spatialIndex,
    view,
    meta,
    createdAt: Date.now(),
  };
  
  // Freeze entire snapshot in dev
  if (process.env.NODE_ENV === 'development') {
    return Object.freeze(snapshot);
  }
  
  return snapshot;
}
```

### 5. WriteQueue Validation Order (EXACT)

```typescript
validate(cmd: Command): ValidationResult {
  // CRITICAL: Check in this EXACT order
  
  // 1. Mobile check FIRST
  if (this.config.isMobile) {
    return { 
      valid: false, 
      reason: 'view_only', 
      details: 'Mobile devices are view-only' 
    };
  }
  
  // 2. Size check SECOND
  const currentSize = this.config.getCurrentSize();
  if (currentSize >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES) {
    return { 
      valid: false, 
      reason: 'read_only', 
      details: 'Room size limit exceeded' 
    };
  }
  
  // 3. Idempotency check THIRD
  const idempotencyKey = this.getIdempotencyKey(cmd);
  if (this.idempotencyMap.has(idempotencyKey)) {
    return { 
      valid: false, 
      reason: 'invalid_data', 
      details: 'Duplicate command' 
    };
  }
  
  // 4. Rate limit check FOURTH
  if (!this.checkRateLimit(cmd)) {
    return { 
      valid: false, 
      reason: 'rate_limited', 
      details: 'Command rate limited' 
    };
  }
  
  // 5. Command-specific validation FIFTH
  const specificValidation = this.validateCommand(cmd);
  if (!specificValidation.valid) {
    return specificValidation;
  }
  
  // 6. Frame size check LAST
  const estimatedSize = this.estimateEncodedSize(cmd);
  if (estimatedSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) {
    return { 
      valid: false, 
      reason: 'oversize', 
      details: 'Command too large' 
    };
  }
  
  return { valid: true };
}
```

### 6. Command Execution Pattern (EXACT)

```typescript
private async executeCommand(cmd: Command): Promise<void> {
  const helpers = this.config.getHelpers();
  
  // CRITICAL: EXACTLY ONE transaction per command
  this.config.ydoc.transact(() => {
    switch (cmd.type) {
      case 'DrawStrokeCommit': {
        const strokes = helpers.getStrokes();
        
        // CRITICAL: Push as single-element array
        strokes.push([{
          id: cmd.id,
          tool: cmd.tool,
          color: cmd.color,
          size: cmd.size,
          opacity: cmd.opacity,
          points: cmd.points, // MUST be number[], NOT Float32Array
          bbox: cmd.bbox,
          scene: cmd.scene, // CRITICAL: Use captured scene from pointer-down
          createdAt: cmd.startedAt,
          userId: 'current-user', // TODO: From awareness
        }]);
        break;
      }
      
      case 'EraseObjects': {
        // CRITICAL: Delete in REVERSE order
        const strokes = helpers.getStrokes();
        const strokeArray = strokes.toArray();
        const indicesToDelete: number[] = [];
        
        cmd.ids.forEach(id => {
          const index = strokeArray.findIndex(s => s.id === id);
          if (index !== -1) {
            indicesToDelete.push(index);
          }
        });
        
        // Sort descending and delete
        indicesToDelete.sort((a, b) => b - a);
        indicesToDelete.forEach(i => strokes.delete(i, 1));
        break;
      }
      
      case 'ClearBoard': {
        // CRITICAL: Just append timestamp to scene_ticks
        const sceneTicks = helpers.getSceneTicks();
        sceneTicks.push([Date.now()]);
        break;
      }
      
      // ... other cases
    }
  }, `cmd:${cmd.type}`); // Origin for debugging
}
```

### 7. Destroy Cleanup (EXACT)

```typescript
destroy(): void {
  console.log('[RoomDocManager] Destroying');
  
  // 1. Stop RAF loop FIRST
  if (this.publishState.rafId) {
    cancelAnimationFrame(this.publishState.rafId);
    this.publishState.rafId = 0;
  }
  
  // 2. Stop command processing
  this.commandBus?.stop();
  this.commandBus?.destroy();
  this.writeQueue?.destroy();
  
  // 3. Remove Y.Doc observers
  this.ydoc.off('update', this.handleYDocUpdate);
  
  // 4. Run all cleanup handlers
  this.cleanupHandlers.forEach(cleanup => cleanup());
  this.cleanupHandlers = [];
  
  // 5. Close IndexedDB
  if (this.snapshotCache) {
    this.snapshotCache.close();
    this.snapshotCache = null;
  }
  
  // 6. Clear subscribers
  this.snapshotSubscribers.clear();
  this.presenceSubscribers.clear();
  this.statsSubscribers.clear();
  
  // 7. Destroy providers (when they exist)
  // this.indexeddbProvider?.destroy();
  // this.websocketProvider?.destroy();
  // this.webrtcProvider?.destroy();
  
  // 8. Destroy Y.Doc LAST
  this.ydoc.destroy();
  
  // 9. Remove from registry
  RoomDocManagerRegistry.remove(this.roomId);
}
```

### 8. Mobile Detection (EXACT)

```typescript
private detectMobile(): boolean {
  // Handle Node.js environment (testing)
  if (typeof window === 'undefined') return false;
  
  // Check user agent
  const userAgent = window.navigator?.userAgent || '';
  const isMobileAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  
  // Check touch capability
  const hasTouch = 'ontouchstart' in window || 
                   (window.navigator?.maxTouchPoints > 0);
  
  // Check screen size
  const smallScreen = window.innerWidth < 768;
  
  // Mobile if: agent says so, OR (has touch AND small screen)
  return isMobileAgent || (hasTouch && smallScreen);
}
```

### 9. IndexedDB Cache Key (EXACT)

```typescript
private async cacheSnapshot(snapshot: Snapshot): Promise<void> {
  if (!this.snapshotCache) return;
  
  try {
    const transaction = this.snapshotCache.transaction(['snapshots'], 'readwrite');
    const store = transaction.objectStore('snapshots');
    
    // CRITICAL: Key format MUST be roomId:svKey
    const cacheEntry = {
      key: `${this.roomId}:${snapshot.svKey}`, // EXACT format
      roomId: this.roomId,
      svKey: snapshot.svKey,
      timestamp: Date.now(),
      snapshot: {
        // Store MINIMAL data only
        scene: snapshot.scene,
        strokes: snapshot.strokes.map(s => ({
          id: s.id,
          points: s.points, // number[], NOT Float32Array
          style: s.style,
          bbox: s.bbox,
        })),
        texts: snapshot.texts.map(t => ({
          id: t.id,
          x: t.x,
          y: t.y,
          w: t.w,
          h: t.h,
          content: t.content,
          style: t.style,
        })),
        meta: snapshot.meta,
      },
    };
    
    // Store (will replace if exists)
    store.put(cacheEntry);
  } catch (error) {
    // CRITICAL: Failures are non-fatal
    console.warn('[Snapshot] Cache write failed:', error);
  }
}
```

### 10. Scene Capture Pattern (EXACT)

```typescript
// CRITICAL: Scene capture utility - USE THIS PATTERN
class SceneCapture {
  private capturedScene: SceneIdx | null = null;
  private captureTime: number = 0;
  
  capture(roomDocManager: RoomDocManager): SceneIdx {
    // CRITICAL: Capture from current snapshot
    this.capturedScene = roomDocManager.currentSnapshot.scene;
    this.captureTime = Date.now();
    return this.capturedScene;
  }
  
  getRequired(): SceneIdx {
    if (this.capturedScene === null) {
      throw new Error('Scene not captured - must call capture() first');
    }
    return this.capturedScene;
  }
  
  reset(): void {
    this.capturedScene = null;
    this.captureTime = 0;
  }
}

// CRITICAL: Every tool MUST follow this pattern
class Tool {
  private sceneCapture = new SceneCapture();
  
  onInteractionStart() {
    // ALWAYS capture at start
    this.sceneCapture.capture(roomDocManager);
  }
  
  onInteractionEnd() {
    const command = {
      type: 'DrawStrokeCommit',
      scene: this.sceneCapture.getRequired(), // NEVER re-read current
      // ... other fields
    };
    roomDocManager.write(command);
    this.sceneCapture.reset();
  }
}
```

### 11. Backpressure Handling (EXACT)

```typescript
private async processBatch(): Promise<void> {
  if (this.processing) return;
  
  this.processing = true;
  const startTime = performance.now();
  
  try {
    // CRITICAL: Respect budget
    const budget = PERFORMANCE_CONFIG.TRANSACT_BUDGET_MS;
    
    while (this.config.writeQueue.size() > 0) {
      const elapsed = performance.now() - startTime;
      
      // CRITICAL: Yield if over budget
      if (elapsed > budget) {
        await new Promise(resolve => setTimeout(resolve, 0));
        break; // Process more next tick
      }
      
      const cmd = this.config.writeQueue.dequeue();
      if (!cmd) break;
      
      await this.executeCommand(cmd);
    }
    
    // CRITICAL: Adapt batch window
    const totalTime = performance.now() - startTime;
    if (totalTime > 8) {
      // Slow - expand window
      this.batchWindow = Math.min(32, this.batchWindow * 1.5);
    } else if (totalTime < 4 && this.batchWindow > 16) {
      // Fast - contract window
      this.batchWindow = Math.max(8, this.batchWindow * 0.8);
    }
    
  } finally {
    this.processing = false;
  }
}
```

---

## ❌ ANTI-PATTERNS: Never Do These

### 1. NEVER Cache Y References
```typescript
// ❌ WRONG
private yStrokes: Y.Array<Stroke>;

constructor() {
  this.yStrokes = this.ydoc.getArray('strokes'); // ❌ Cached reference
}

// ✅ CORRECT
private getStrokes(): Y.Array<Stroke> {
  return this.getRoot().get('strokes') as Y.Array<Stroke>;
}
```

### 2. NEVER Allow Null Snapshot
```typescript
// ❌ WRONG
private _currentSnapshot: Snapshot | null = null;

// ✅ CORRECT  
private _currentSnapshot: Snapshot = createEmptySnapshot();
```

### 3. NEVER Store Float32Array in Yjs
```typescript
// ❌ WRONG
strokes.push([{
  points: new Float32Array([0, 0, 10, 10]), // ❌ Typed array
}]);

// ✅ CORRECT
strokes.push([{
  points: [0, 0, 10, 10], // ✓ Plain array
}]);
```

### 4. NEVER Multiple Transactions
```typescript
// ❌ WRONG
ydoc.transact(() => { /* part 1 */ });
ydoc.transact(() => { /* part 2 */ }); // ❌ Split transaction

// ✅ CORRECT
ydoc.transact(() => {
  // All changes in ONE transaction
});
```

### 5. NEVER Forget Cleanup
```typescript
// ❌ WRONG
destroy() {
  // Forgot to cancel RAF
  // Forgot to remove observer
}

// ✅ CORRECT
destroy() {
  cancelAnimationFrame(this.rafId);
  this.ydoc.off('update', this.handler);
  // ... all cleanup
}
```

---

## 🎯 Key Success Metrics

When implementation is correct:

1. **Snapshot Publishing**
   - Published exactly once per RAF (not multiple)
   - svKey stable when Y.Doc unchanged
   - Batch window stays between 8-32ms
   - Hidden tab properly reduces to 8 FPS

2. **Command Processing**
   - Mobile writes rejected with 'view_only'
   - Duplicate commands rejected via idempotency
   - Rate limits enforced (15s for ClearBoard)
   - Each command in single transaction

3. **Memory Management**
   - No retained Y references
   - No growing arrays
   - Cleanup removes all handlers
   - IDB connections closed

4. **Performance**
   - 60 FPS maintained under normal load
   - Commands process within 8ms budget
   - Backpressure prevents queue overflow
   - Adaptive windows respond to load

---

## Final Implementation Order

1. **First**: Update constructor with Phase 2.4 calls
2. **Second**: Implement all Phase 2.4 methods (observers, RAF, etc.)
3. **Third**: Test snapshot publishing works
4. **Fourth**: Add WriteQueue class
5. **Fifth**: Add CommandBus class  
6. **Sixth**: Wire up write() method
7. **Seventh**: Update destroy() with all cleanup
8. **Eighth**: Run integration tests
9. **Ninth**: Profile memory and performance
10. **Tenth**: Run validation checklist

Follow this order exactly for best results!