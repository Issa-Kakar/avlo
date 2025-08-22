# 🔴 CRITICAL: Scene Capture Architecture Lock-In

## Why This Document Exists

Scene capture is a **fundamental distributed systems constraint** that ensures causal consistency. This document locks in the requirements to prevent a critical bug that would break temporal ordering in collaborative editing.

## The Problem

In a distributed whiteboard with concurrent users and a "Clear Board" feature:
- User A starts drawing in Scene 0
- User B clears the board (increments to Scene 1)
- User A finishes drawing

**Without proper scene capture:** User A's stroke appears in Scene 1 (wrong!)
**With proper scene capture:** User A's stroke correctly stays in Scene 0

## What We're Locking In

### 1. Scene is REQUIRED on Content Commands

```typescript
// These commands MUST have scene field
type ContentCommand = {
  type: 'DrawStrokeCommit' | 'AddText' | 'AddStamp';
  scene: SceneIdx;  // REQUIRED, not optional
  // ... other fields
};
```

### 2. Scene Capture at Interaction Start

```typescript
// MUST capture at these events:
- pointerdown
- touchstart
- stylus contact
- keyboard shortcut trigger
- tool activation

// NOT at these events:
- pointermove
- pointerup  // Too late!
- commit time // Wrong!
```

### 3. CommandBus NEVER Re-reads Scene

```typescript
// The CommandBus MUST use cmd.scene, NEVER getCurrentScene()
case 'DrawStrokeCommit': {
  strokes.push([{
    scene: cmd.scene,  // ✅ CORRECT
    // scene: getCurrentScene(), // ❌ NEVER
  }]);
}
```

### 4. SceneCapture Utility Pattern

Every tool MUST use this pattern:

```typescript
class AnyTool {
  private sceneCapture = new SceneCapture();
  
  onStart() {
    this.sceneCapture.capture(roomDocManager);
  }
  
  onCommit() {
    const scene = this.sceneCapture.getRequired();
    // Use captured scene in command
  }
}
```

## Test Requirements

### Critical Test Case #1: Scene Preservation
```
1. Start drawing (Scene 0 captured)
2. ClearBoard happens (now Scene 1)
3. Finish drawing
4. Assert: stroke.scene === 0 (not 1)
```

### Critical Test Case #2: Multi-Touch
```
1. Touch1 starts (Scene 0 captured)
2. ClearBoard (now Scene 1)
3. Touch2 starts (Scene 1 captured)
4. ClearBoard (now Scene 2)
5. Both finish
6. Assert: touch1.scene === 0, touch2.scene === 1
```

### Property Test
```
For ANY sequence of [pointerDown, ClearBoard*, pointerUp]:
- The committed scene === scene at pointerDown
```

## Development Assertions

Add these assertions in development builds:

```typescript
if (process.env.NODE_ENV === 'development') {
  // Scene can't be from future
  assert(cmd.scene <= currentScene);
  
  // Scene must be defined
  assert(cmd.scene !== undefined);
  assert(cmd.scene !== null);
  
  // Log for debugging
  console.log(`[Scene] Captured: ${cmd.scene}, Current: ${currentScene}`);
}
```

## Migration Strategy

### Phase 1: Add Scene Field (Current)
- Make scene required in TypeScript types
- Add SceneCapture utility
- Update CommandBus to use cmd.scene

### Phase 2: Back-Compat Shim (Temporary)
```typescript
// For old clients missing scene
if (!cmd.scene) {
  console.warn('Missing scene, using current');
  cmd.scene = getCurrentScene();
}
```

### Phase 3: Remove Shim (After All Clients Updated)
- Monitor metrics for missing scene
- When 0% missing, remove shim
- Throw error if scene missing

## Monitoring

Track these metrics:
- `commands.missing_scene` - Should trend to 0
- `scene.capture_to_commit_delta` - Time between capture and commit
- `scene.future_scene_errors` - Should be 0
- `scene.clearboard_during_gesture` - Frequency of the edge case

## Why This Matters

1. **Causal Consistency**: Events happen in the order users perceive
2. **User Experience**: Drawings don't jump between scenes
3. **Collaboration**: Multiple users see consistent state
4. **Undo/Redo**: Operations preserve original context
5. **Export**: Scenes export with correct content

## Red Flags in Code Review

❌ `getCurrentScene()` in any command execution
❌ `scene: number | undefined` (must be required)
❌ Missing `sceneCapture.capture()` at interaction start
❌ Re-reading scene at commit time
❌ Tool switches that don't preserve scene

## Green Flags in Code Review

✅ `scene: cmd.scene` in CommandBus
✅ `sceneCapture.capture()` at pointerDown
✅ Scene field required in TypeScript
✅ Tests for ClearBoard during gesture
✅ Assertions for scene consistency

## Summary

**The Golden Rule:** Scene is captured ONCE at interaction start and that SAME value is used at commit, regardless of what happens in between.

This is non-negotiable for distributed systems correctness.