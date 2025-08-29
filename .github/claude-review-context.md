# Claude Code Review Context for Avlo

## Critical Bug Patterns to Check

### Y.Doc Memory Leaks

```typescript
// ❌ BUG: Cached Y reference - causes memory leak and stale data
class Manager {
  private yStrokes: Y.Array<any>; // MEMORY LEAK!
  constructor() {
    this.yStrokes = ydoc.getMap('root').get('strokes');
  }
}

// ✅ CORRECT: Always traverse from root
class Manager {
  private getStrokes(): Y.Array<any> {
    return this.ydoc.getMap('root').get('strokes') as Y.Array<any>;
  }
}
```

### RAF Loop Cleanup

```typescript
// ❌ BUG: No cleanup - memory leak
useEffect(() => {
  const id = requestAnimationFrame(loop);
});

// ✅ CORRECT: Proper cleanup
useEffect(() => {
  const id = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(id);
}, []);
```

### Event Listener Leaks

```typescript
// ❌ BUG: No removal - memory leak
componentDidMount() {
  window.addEventListener('resize', this.handleResize);
}

// ✅ CORRECT: Remove on unmount
componentDidMount() {
  window.addEventListener('resize', this.handleResize);
}
componentWillUnmount() {
  window.removeEventListener('resize', this.handleResize);
}
```

### Subscription Cleanup

```typescript
// ❌ BUG: No unsubscribe - memory leak
useEffect(() => {
  const unsub = manager.subscribeSnapshot(callback);
  // Missing return!
}, []);

// ✅ CORRECT: Return cleanup function
useEffect(() => {
  const unsub = manager.subscribeSnapshot(callback);
  return unsub;
}, []);
```

### Null Reference Bugs

```typescript
// ❌ BUG: Potential null reference
const stroke = strokes.find((s) => s.id === id);
stroke.points.length; // Could crash!

// ✅ CORRECT: Guard against null
const stroke = strokes.find((s) => s.id === id);
if (stroke) {
  stroke.points.length;
}
```

### Array Index Bugs

```typescript
// ❌ BUG: Unsafe array access
const lastPoint = points[points.length - 1];
lastPoint.x; // Crashes if points is empty!

// ✅ CORRECT: Check length first
if (points.length > 0) {
  const lastPoint = points[points.length - 1];
  lastPoint.x;
}
```

### CRDT Race Conditions

```typescript
// ❌ BUG: Multiple transactions - race condition
room.mutate((ydoc) => {
  /* op1 */
});
room.mutate((ydoc) => {
  /* op2 */
}); // May see stale state!

// ✅ CORRECT: Single transaction
room.mutate((ydoc) => {
  /* op1 */
  /* op2 */
});
```

### Float32Array Storage Bug

```typescript
// ❌ BUG: Storing typed array in Yjs
room.mutate((ydoc) => {
  stroke.points = new Float32Array(points); // WRONG!
});

// ✅ CORRECT: Store as number[]
room.mutate((ydoc) => {
  stroke.points = Array.from(points);
});
```

### Direct Yjs Import Bug

```typescript
// ❌ BUG: UI component importing Yjs
import * as Y from 'yjs'; // ESLint should catch this!
import { WebsocketProvider } from 'y-websocket'; // WRONG!

// ✅ CORRECT: Use manager API
import { useRoomSnapshot } from '@/hooks';
```

### Scene Assignment Bug

```typescript
// ❌ BUG: Scene captured at gesture start
const scene = currentScene; // At pointer-down
// ... later at pointer-up
stroke.scene = scene; // Wrong if clear happened!

// ✅ CORRECT: Assign at commit time
room.mutate((ydoc) => {
  stroke.scene = getCurrentScene(); // At commit time
  strokes.push([stroke]);
});
```

## Performance Anti-Patterns

### Excessive Re-renders

- Creating new objects in render
- Missing React.memo on pure components
- Not using selectors with Zustand

### Inefficient Canvas Operations

- Full canvas clear instead of dirty rect
- Building Path2D on every frame
- Not caching stroke render data

### Memory Issues

- Holding references to old snapshots
- Not limiting array sizes (outputs, presence)
- Unbounded caches without eviction

## Common Async Bugs

### Missing Error Handling

- Unhandled promise rejections
- No try-catch in async functions
- Missing error boundaries in React

### Race Conditions

- setState after unmount
- Multiple concurrent fetches
- Uncoordinated provider initialization

## Type Safety Issues

### Any Types Outside Tests

- Using `any` in production code
- Missing null checks on optional types
- Incorrect type assertions

### Registry Pattern Violations

- Direct instantiation of RoomDocManagerImpl
- Not using createTestManager in tests
- Accessing private fields from outside

Remember: Focus only on actual bugs, not style or documentation issues.
