# PHASE 3.1 IMPLEMENTATION INSTRUCTIONS - Canvas Infrastructure

## PROJECT CONTEXT

**Project**: Avlo - A link-based, account-less, offline-first, real-time collaborative whiteboard with integrated code execution
**Current Status**: Phase 2 (Core Data Layer & Models) COMPLETED
**Next Phase**: Phase 3.1.1 and 3.1.2 - Basic Canvas Infrastructure

## CRITICAL PROJECT ARCHITECTURE RULES (MUST FOLLOW)

### 1. Y.Doc Reference Invariants (NEVER VIOLATE)

- **NO cached Y references as class fields**
- **Helpers return Y types ONLY for internal use**
- **NEVER expose Y types from public methods**
- The canvas component being created MUST NOT import or use Yjs directly

### 2. UI Isolation from Yjs

- UI components **MUST NOT** import `yjs`, `y-websocket`, `y-indexeddb`, `y-webrtc`
- ESLint enforces this via `no-restricted-imports` rule (see `/home/issak/dev/avlo/eslint.config.js` lines 69-99)
- All data access goes through RoomDocManager public API (immutable snapshots only)
- The canvas component we're creating is a UI component and MUST follow this rule

### 3. Immutable Snapshots Pattern

- Components receive `Snapshot` objects (defined in `/home/issak/dev/avlo/packages/shared/src/types/snapshot.ts`)
- Snapshots are frozen, immutable, and NEVER null
- `ViewTransform` interface already exists and will be used (lines 59-65 in snapshot.ts)

## CODEBASE INVESTIGATION RESULTS

### Current Project Structure

```
avlo/
├── client/                    # React frontend
│   ├── src/
│   │   ├── hooks/            # React hooks (use-room-snapshot.ts, etc.)
│   │   ├── lib/              # Core library (room-doc-manager.ts, render-cache.ts)
│   │   │   └── tools/        # Tool implementations (future)
│   │   ├── stores/           # Zustand stores for device-local UI state
│   │   ├── types/            # (Currently empty - client-specific types go here)
│   │   ├── App.tsx           # Minimal placeholder currently
│   │   └── main.tsx          # Application entry point
├── packages/shared/          # Shared types and configuration
│   └── src/
│       ├── types/            # Shared type definitions
│       │   └── snapshot.ts   # Contains ViewTransform interface
│       └── config.ts         # All constants with env overrides
```

### Key Discoveries

1. **No existing canvas components** - We're creating from scratch
2. **ViewTransform already defined** in `/home/issak/dev/avlo/packages/shared/src/types/snapshot.ts` (lines 60-65):
   ```typescript
   export interface ViewTransform {
     worldToCanvas: (x: number, y: number) => [number, number];
     canvasToWorld: (x: number, y: number) => [number, number];
     scale: number; // world px → canvas px
     pan: { x: number; y: number }; // world offset
   }
   ```
3. **Testing infrastructure** uses Vitest with jsdom environment
4. **Import aliases configured**:
   - `@/*` → `./src/*` (within client)
   - `@avlo/shared` → `../packages/shared/src/*`
5. **TestFrameScheduler exists** in `timing-abstractions.ts` (for future phases that need precise RAF control - not needed for Phase 3.1)

## PHASE 3.1 SPECIFIC REQUIREMENTS

### Phase 3.1.1: Create Canvas Component Structure

**Goals**:

1. Create React component wrapping HTML `<canvas>`
2. Proper sizing with ResizeObserver
3. Device pixel ratio (DPR) handling for crisp rendering
4. Clean lifecycle management

### Phase 3.1.2: Initialize 2D Rendering Context

**Goals**:

1. Obtain 2D context with correct options
2. Configure baseline defaults (smoothing, line caps/joins)
3. Implement state hygiene pattern (save/restore)
4. Create clear method using clearRect

## DETAILED IMPLEMENTATION STEPS

### STEP 1: Create Directory Structure

```bash
# Create the canvas directory in client/src
mkdir -p /home/issak/dev/avlo/client/src/canvas
```

### STEP 2: Create CanvasStage Component

**File**: `/home/issak/dev/avlo/client/src/canvas/CanvasStage.tsx`

#### Component Requirements:

1. **React Component with forwardRef** to expose imperative API
2. **Props Interface**:

   ```typescript
   interface CanvasStageProps {
     className?: string;
     style?: React.CSSProperties;
     onResize?: (info: ResizeInfo) => void;
   }

   interface ResizeInfo {
     cssWidth: number;
     cssHeight: number;
     dpr: number;
     pixelWidth: number;
     pixelHeight: number;
   }
   ```

3. **Imperative Handle Interface**:

   ```typescript
   interface CanvasStageHandle {
     clear(): void;
     withContext(run: (ctx: CanvasRenderingContext2D) => void): void;
   }
   ```

4. **Implementation Details**:
   - Use `useRef<HTMLCanvasElement>(null)` for canvas element
   - Use `useRef<CanvasRenderingContext2D | null>(null)` for context
   - Use `useRef<ResizeObserver | null>(null)` for resize observer
   - Use `useRef<number>(window.devicePixelRatio || 1)` for current DPR value
   - Use `useRef<{ cssWidth: number; cssHeight: number }>(...)` for canvas dimensions

5. **ResizeObserver Setup**:

   ```typescript
   // In useEffect on mount
   // IMPORTANT: Use entry.contentRect for content-box sizing to avoid feedback loops
   const observer = new ResizeObserver((entries) => {
     for (const entry of entries) {
       const { width, height } = entry.contentRect; // CSS pixels
       const dpr = window.devicePixelRatio || 1;

       // Store current values in refs for use in clear() and withContext()
       dprRef.current = dpr;
       dimensionsRef.current = { cssWidth: width, cssHeight: height };

       // Set canvas buffer size (actual device pixels)
       // This changes backing store only, not CSS dimensions
       canvas.width = width * dpr;
       canvas.height = height * dpr;

       // Get context if first time
       if (!ctxRef.current) {
         const ctx = canvas.getContext('2d', { willReadFrequently: false });
         if (!ctx) {
           console.error('Failed to get 2D context');
           return;
         }
         ctxRef.current = ctx;
         configureContext2D(ctx); // Apply defaults
       }

       // Apply device scale transform for DPR-aware rendering
       ctxRef.current.setTransform(dpr, 0, 0, dpr, 0, 0);

       // Notify parent
       onResize?.({
         cssWidth: width,
         cssHeight: height,
         dpr,
         pixelWidth: width * dpr,
         pixelHeight: height * dpr,
       });
     }
   });

   observer.observe(canvasRef.current);
   ```

6. **DPR Change Listener**:

   ```typescript
   // Listen for DPR changes (e.g., moving between monitors)
   // Must recreate media query after each change to listen for next change
   const dprChangeListenerRef = useRef<MediaQueryList | null>(null);

   const setupDPRListener = () => {
     // Clean up previous listener
     if (dprChangeListenerRef.current) {
       dprChangeListenerRef.current.removeEventListener('change', handleDPRChange);
     }

     const dpr = window.devicePixelRatio || 1;
     const mediaQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);

     const handleDPRChange = () => {
       // Re-run the resize logic with new DPR
       if (canvasRef.current) {
         const rect = canvasRef.current.getBoundingClientRect();
         const newDpr = window.devicePixelRatio || 1;

         // Update stored values
         dprRef.current = newDpr;

         // Reapply sizing and transforms
         canvasRef.current.width = rect.width * newDpr;
         canvasRef.current.height = rect.height * newDpr;

         if (ctxRef.current) {
           ctxRef.current.setTransform(newDpr, 0, 0, newDpr, 0, 0);
         }

         // Recreate listener for the new DPR value
         setupDPRListener();
       }
     };

     mediaQuery.addEventListener('change', handleDPRChange);
     dprChangeListenerRef.current = mediaQuery;
   };

   // Call on mount
   setupDPRListener();
   ```

7. **Context Initialization** (handled in ResizeObserver):
   - Context is obtained once in ResizeObserver with null checking
   - Defaults applied via `configureContext2D()` helper
   - Context reference stored in `ctxRef` for reuse

8. **Imperative Methods**:

   ```typescript
   clear(): void {
     const ctx = ctxRef.current;
     const canvas = canvasRef.current;
     if (!ctx || !canvas) return;

     // RECOMMENDED: Option A - Reset to identity, clear device pixels
     // This is more predictable and doesn't depend on current transform state
     ctx.save();
     ctx.setTransform(1, 0, 0, 1, 0, 0);  // Identity transform
     ctx.clearRect(0, 0, canvas.width, canvas.height); // Device pixels
     ctx.restore();

     // Alternative Option B: Keep DPR transform, clear CSS pixels
     // (commented out but shown for reference)
     // const { cssWidth, cssHeight } = dimensionsRef.current;
     // ctx.clearRect(0, 0, cssWidth, cssHeight); // CSS pixels
   }

   withContext(run: (ctx: CanvasRenderingContext2D) => void): void {
     const ctx = ctxRef.current;
     if (!ctx) return;

     ctx.save();
     try {
       run(ctx);
     } finally {
       ctx.restore();
     }
   }
   ```

9. **Cleanup on Unmount**:
   ```typescript
   return () => {
     resizeObserverRef.current?.disconnect();
     dprChangeListenerRef.current?.removeEventListener('change', handleDPRChange);
     // Null all refs
     ctxRef.current = null;
     resizeObserverRef.current = null;
     dprChangeListenerRef.current = null;
   };
   ```

### STEP 3: Create Internal Context Helper

**File**: `/home/issak/dev/avlo/client/src/canvas/internal/context2d.ts`

This file contains helper functions for context management:

```typescript
export interface Context2DConfig {
  imageSmoothingEnabled?: boolean;
  lineCap?: CanvasLineCap;
  lineJoin?: CanvasLineJoin;
}

export function configureContext2D(
  ctx: CanvasRenderingContext2D,
  config: Context2DConfig = {},
): void {
  ctx.imageSmoothingEnabled = config.imageSmoothingEnabled ?? true;
  ctx.lineCap = config.lineCap ?? 'round';
  ctx.lineJoin = config.lineJoin ?? 'round';
}
```

### STEP 4: Canvas Element CSS Setup

To avoid ResizeObserver feedback loops and ensure proper sizing:

```tsx
// In the component render
<canvas
  ref={canvasRef}
  style={{
    display: 'block', // Remove inline spacing
    width: '100%', // Fill parent width
    height: '100%', // Fill parent height
    touchAction: 'none', // Prepare for Phase 5 pointer events
  }}
  className={className}
/>
```

**IMPORTANT**: The canvas CSS dimensions should be controlled by its parent container. The ResizeObserver reads `contentRect` which gives content-box dimensions, avoiding border/padding in calculations.

### STEP 5: Add JSDoc Documentation

Add comprehensive JSDoc comments explaining:

1. The component's role as a "render substrate"
2. How it maintains the Y.Doc isolation boundary
3. The DPR handling strategy
4. Clear() method coordinate space choice
5. Where future phases will plug in (ViewTransform from 3.2, render loop from 3.3)

Example:

```typescript
/**
 * CanvasStage - A render substrate for the whiteboard
 *
 * This component provides a properly sized, DPR-aware canvas element
 * without any knowledge of Y.Doc or CRDT structures. It's a pure
 * rendering surface that will be driven by immutable snapshots.
 *
 * Architecture boundaries:
 * - NO imports of yjs, y-websocket, y-indexeddb, or y-webrtc
 * - Receives only immutable data structures
 * - Future ViewTransform (Phase 3.2) applied via withContext
 * - Render loop (Phase 3.3) will call withContext for drawing
 *
 * DPR Handling:
 * - Canvas backing store sized to device pixels (width * dpr)
 * - Default transform applies DPR scaling
 * - Clear() uses identity transform + device pixels (Option A)
 * - DPR changes trigger re-binding of media query listener
 */
```

### STEP 6: Create Minimal Tests

**File**: `/home/issak/dev/avlo/client/src/canvas/__tests__/CanvasStage.test.tsx`

Since this is 1/4 of Phase 3, keep tests minimal and focused:

```typescript
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
import { CanvasStage, type CanvasStageHandle } from '../CanvasStage';

describe('CanvasStage', () => {
  // Mock ResizeObserver locally (not globally)
  beforeEach(() => {
    global.ResizeObserver = vi.fn().mockImplementation((callback) => ({
      observe: vi.fn((element) => {
        // Simulate a resize immediately
        callback([{
          target: element,
          contentRect: { width: 800, height: 600 }
        }]);
      }),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));

    // Mock canvas getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
    });
  });

  it('creates canvas element and gets 2D context', () => {
    const { container } = render(<CanvasStage />);
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeTruthy();
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith('2d', {
      willReadFrequently: false
    });
  });

  it('exposes clear method through ref', () => {
    const ref = { current: null as CanvasStageHandle | null };

    render(<CanvasStage ref={ref} />);

    // After render, the ref should be populated
    expect(ref.current).toBeTruthy();
    expect(ref.current?.clear).toBeDefined();
    expect(ref.current?.withContext).toBeDefined();
  });

  it('cleans up on unmount', () => {
    const { unmount } = render(<CanvasStage />);
    const mockDisconnect = vi.fn();

    // Get the ResizeObserver instance
    const resizeObserverInstance = (ResizeObserver as any).mock.results[0].value;
    resizeObserverInstance.disconnect = mockDisconnect;

    unmount();
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
```

**Note**: jsdom doesn't implement real canvas rendering. We mock the necessary methods and verify they're called correctly. More comprehensive visual tests can be done in E2E tests later.

### STEP 7: Integration Preparation

Create placeholder comments for future integration:

```typescript
// Phase 3.2 Integration Point: ViewTransform
// The ViewTransform from props will be applied here within withContext
// Example: ctx.transform(view.scale, 0, 0, view.scale, view.pan.x, view.pan.y)

// Phase 3.3 Integration Point: Render Loop
// The render loop will call withContext to draw layers:
// 1. Background
// 2. Strokes (Phase 4)
// 3. Text (Phase 11)
// 4. Overlays (Phase 8)

// Phase 5 Integration Point: Pointer Events
// Event listeners will be attached to the canvas element or a sibling overlay
```

## OUT OF SCOPE (DO NOT IMPLEMENT)

1. **Render loop** - Phase 3.3
2. **Dirty rectangle tracking** - Phase 3.3
3. **Actual drawing of strokes** - Phase 4
4. **Pointer input handling** - Phase 5
5. **Presence overlays** - Phase 8
6. **ViewTransform application** - Phase 3.2 (just prepare the seam)

## ACCEPTANCE CRITERIA

### Must Pass All:

1. ✅ Canvas element properly sized with ResizeObserver (using contentRect)
2. ✅ DPR-correct sizing (canvas.width = cssWidth \* dpr)
3. ✅ Device scale transform applied after resize
4. ✅ Context initialized with correct defaults and null-checked
5. ✅ clear() method uses consistent coordinate space
6. ✅ withContext() provides save/restore pattern
7. ✅ DPR change listener properly rebinds after changes
8. ✅ Clean teardown on unmount (all refs nulled, listeners removed)
9. ✅ NO imports of yjs, y-websocket, y-indexeddb, y-webrtc
10. ✅ Minimal tests pass (context creation, ref API, cleanup)

### Visual Verification:

- Draw a 1px line at scale=1, verify it's exactly 1 device pixel wide
- Canvas fills container without scrollbars
- No blur or resampling artifacts

## COMMON PITFALLS TO AVOID

1. **CSS Transforms**: Do NOT apply CSS scale/transform to the canvas element - causes blur
2. **Border/Padding**: Use content-box sizing (entry.contentRect) for ResizeObserver to avoid calculation errors
3. **Memory Leaks**: Ensure ResizeObserver disconnects and refs are nulled
4. **Context Loss**: Always check if context exists before operations (handle null case)
5. **Wrong Imports**: The component must not import from 'yjs' or providers
6. **Clear Coordinate Mismatch**: Ensure clear() uses consistent coordinates - either identity + device pixels OR DPR + CSS pixels
7. **DPR Listener Leak**: Must recreate media query after each DPR change to listen for next change
8. **Resize Feedback Loop**: Observe parent element or ensure CSS dimensions are stable when changing backing store

## FILE CREATION ORDER

1. First: `/home/issak/dev/avlo/client/src/canvas/internal/context2d.ts`
2. Second: `/home/issak/dev/avlo/client/src/canvas/CanvasStage.tsx`
3. Third: `/home/issak/dev/avlo/client/src/canvas/__tests__/CanvasStage.test.tsx`

## TYPESCRIPT NOTES

- Import `ViewTransform` from `@avlo/shared` when needed (Phase 3.2)
- Use proper React types: `React.ForwardedRef`, `React.CSSProperties`
- Canvas element type: `HTMLCanvasElement`
- Context type: `CanvasRenderingContext2D`

## TESTING COMMANDS

After implementation:

```bash
# Run tests
npm test -- CanvasStage

# Type check
npm run typecheck

# Lint check (verify no restricted imports)
npm run lint
```

## FINAL CHECKLIST FOR IMPLEMENTER

Before marking complete:

- [ ] Created canvas directory structure
- [ ] Implemented CanvasStage component with:
  - [ ] Proper ResizeObserver using contentRect
  - [ ] DPR handling with stored refs
  - [ ] Clear() method with consistent coordinates
  - [ ] DPR change listener that rebinds
  - [ ] CSS setup (display:block, width/height:100%)
- [ ] Added context2d helper utilities
- [ ] Wrote comprehensive JSDoc comments
- [ ] Created minimal test file (3-4 tests max)
- [ ] Verified NO yjs imports (ESLint passes)
- [ ] Verified clean unmount (no console errors)
- [ ] Added integration point comments for future phases

## SUCCESS INDICATORS

You know you've succeeded when:

1. The component renders a canvas that fills its container
2. Lines drawn are pixel-perfect (no blur)
3. The canvas properly resizes when the window resizes
4. Tests pass for all acceptance criteria
5. ESLint shows no errors about restricted imports
6. The component can be imported and used without any Y.Doc knowledge

## NOTES FOR NEXT PHASES

- **Phase 3.2** will add ViewTransform application inside withContext
- **Phase 3.3** will add the render loop and dirty rect tracking
- **Phase 4** will implement actual stroke rendering
- The component's API is designed to remain stable through all these additions

---

**IMPORTANT**: This canvas component is a foundational piece. It must be rock-solid, properly abstracted, and follow all architectural rules. Take time to get it right - future phases depend on this clean foundation.
