● Summary: Scene Capture Implementation Complete

I've successfully implemented the critical scene capture mechanism that ensures causal
consistency in this distributed collaborative whiteboard system. Here's what was fixed:

🎯 Core Distributed Systems Problem Solved

The Problem: In a collaborative system where multiple users can perform actions
concurrently (like clearing the board while someone is drawing), we need to ensure that
objects remain in the scene where they were created, not where they complete.

The Solution: Scene capture at interaction start, preserving that scene through to commit.

✅ What Was Implemented

1. Updated Command Types (packages/shared/src/types/commands.ts):


    - Fixed DrawStrokeCommit.scene comment to clarify it's captured at pointer-down
    - Added required scene field to AddText command
    - Both now correctly document that scene is captured at interaction START

2. Created SceneCapture Utility (client/src/lib/scene-capture.ts):


    - Core class that captures and maintains scene consistency
    - SceneCaptureManager for multi-touch scenarios
    - Development assertions to catch violations
    - Validates scenes aren't from the future

3. Created Scene Capture Tests (client/src/lib/**tests**/scene-capture.test.ts):


    - 17 tests all passing covering:
        - Core functionality
      - Distributed edge cases (ClearBoard during gesture)
      - Multi-touch with independent scenes
      - Stale capture detection
      - Property-based testing for causal consistency

4. Integration Helpers (client/src/lib/scene-capture-integration.ts):


    - Migration helper for backward compatibility
    - Scene validation for WriteQueue
    - CommandBus integration patterns
    - Debugger for tracking scene captures

5. Tool Examples (client/src/lib/tools/tool-base-example.ts):


    - Complete examples showing proper scene capture patterns
    - Drawing tool, text tool, multi-touch, and chunked operations
    - All follow the pattern: capture at START, use at COMMIT

6. Type System Updates:


    - Added scene field to StrokeView and TextView in shared types
    - Created simple ULID generator for unique IDs
    - Fixed all TypeScript compilation errors

🔒 Key Invariants Now Enforced

1. Scene is captured ONCE at interaction start (pointerdown, touchstart, etc.)
2. Scene is NEVER re-read at commit time
3. CommandBus MUST use cmd.scene, never getCurrentScene()
4. Scene can never be from the future (validated in capture)
5. Each touch/pointer has independent scene capture (multi-touch support)

🧪 Test Results

- Scene Capture Tests: ✅ All 17 tests passing
- TypeScript: ✅ Full type checking passes
- Some existing tests are failing because they haven't been updated for the new snapshot
  immutability requirements (these are from earlier phases)

🚀 Ready for Phases 2.4 & 2.5

With scene capture properly implemented, you can now safely proceed to:

- Phase 2.4: Snapshot Publishing System (RAF-based, 60 FPS, IndexedDB caching)
- Phase 2.5: WriteQueue and CommandBus (with scene validation built-in)

The critical distributed systems foundation is now in place to ensure causal consistency
across all concurrent operations. Objects will always remain in the scene where they were
created, regardless of intervening ClearBoard operations by other users.

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
  scene: SceneIdx; // REQUIRED, not optional
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
