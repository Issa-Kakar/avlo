# Phase 6 Implementation Guide: Complete Persistence Infrastructure

## Overview

Phase 6 implements the complete persistence infrastructure for Avlo, including offline-first IndexedDB storage, WebSocket real-time sync, Redis persistence, PostgreSQL metadata, and all associated gates and failure modes. This is a critical phase that establishes the foundation for all future collaboration features.

## Architecture Context

- **RoomDocManager** (`client/src/lib/room-doc-manager.ts`) is the central authority owning Y.Doc and providers
- **Registry Pattern** ensures singleton-per-room guarantee via `RoomDocManagerRegistry`
- **Provider Order**: y-indexeddb → y-websocket (WebRTC comes in Phase 17)
- **Gates** control feature availability with explicit timeouts and fallbacks
- **Boot visuals (MVP pivot):** No boot splash. RoomDocManager **never** touches the DOM. First paint is **`EmptySnapshot`**, followed by the first doc-derived snapshot via RAF. Render cache is **not** used by Phase 6.
- **Zod** validates boundaries at environment, HTTP, and WebSocket control layers

## Phase 6A: Offline-First Doc Persistence & Boot Gates

> **⚠️ CRITICAL IMPLEMENTATION NOTE**:
> The svKey deduplication optimization that was originally in Phase 2-5 must be removed when implementing Phase 6A.
> The svKey truncation (using only first 100 bytes of state vector) causes a critical bug where local client updates
> are not detected when state vectors exceed 100 bytes (common after IndexedDB loads historical data).
> This results in strokes not rendering until page refresh.
> **Solution**: Always publish when dirty, regardless of svKey comparison.
> See PHASE_6A_DEBUG_REPORT.md for full investigation details.

### 6A.1: Attach y-indexeddb Provider

#### 6A.1.1: Wire Provider Inside RoomDocManager

**File**: `client/src/lib/room-doc-manager.ts`

1. **Import y-indexeddb and types**:

```typescript
import { IndexeddbPersistence } from 'y-indexeddb';
```

2. **Replace unknown type with proper provider type**:

```typescript
// Line 89: Change from
private indexeddbProvider: unknown = null;
// To
private indexeddbProvider: IndexeddbPersistence | null = null;
```

3. **Add gate state tracking**:

```typescript
// After line 136 (destroyed flag), add:
// Gate tracking
private gates = {
  idbReady: false,
  wsConnected: false,
  wsSynced: false,
  awarenessReady: false,
  firstSnapshot: false,
};
private gateTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
private gateCallbacks: Map<string, Set<() => void>> = new Map();
```

4. **Initialize providers in constructor** (after line 185):

```typescript
// Initialize IndexedDB provider (Phase 6A)
this.initializeIndexedDBProvider();
```

5. **Implement provider initialization method** (add after setupObservers method):

```typescript
private initializeIndexedDBProvider(): void {
  try {
    // Create room-scoped IDB provider
    const dbName = `avlo.v1.rooms.${this.roomId}`;
    this.indexeddbProvider = new IndexeddbPersistence(dbName, this.ydoc);

    // Set up IDB gate with 2s timeout
    const timeoutId = setTimeout(() => {
      this.openGate('idbReady');
      console.debug('[RoomDocManager] IDB timeout reached, continuing with empty doc');
    }, 2000);
    this.gateTimeouts.set('idbReady', timeoutId);

    // Listen for IDB sync completion for gate control
    this.indexeddbProvider.whenSynced.then(() => {
      const timeout = this.gateTimeouts.get('idbReady');
      if (timeout) {
        clearTimeout(timeout);
        this.gateTimeouts.delete('idbReady');
      }
      this.openGate('idbReady');
      console.debug('[RoomDocManager] IDB synced successfully');
    }).catch((err) => {
      console.warn('[RoomDocManager] IDB sync error (non-critical):', err);
      // Still open gate on error - fallback to empty doc
      this.openGate('idbReady');
    });

    // Note: No need to listen for 'synced' event to mark dirty
    // Y.Doc updates from IDB will trigger the existing doc update handler

  } catch (err) {
    console.warn('[RoomDocManager] IDB initialization failed (non-critical):', err);
    // Mark as failed but continue
    this.openGate('idbReady');
  }
}
```

#### 6A.1.2: Implement Gate System

**File**: `client/src/lib/room-doc-manager.ts`

Add gate management methods (after initializeIndexedDBProvider):

```typescript
// Gate management
private openGate(gateName: keyof typeof this.gates): void {
  if (this.gates[gateName]) return; // Already open

  this.gates[gateName] = true;

  // Notify subscribers
  const callbacks = this.gateCallbacks.get(gateName);
  if (callbacks) {
    callbacks.forEach(cb => cb());
    callbacks.clear();
  }

  // Note: G_FIRST_SNAPSHOT opens in buildSnapshot() when first doc-derived snapshot publishes
  // Do NOT open it here based on other gates
}

private whenGateOpen(gateName: keyof typeof this.gates): Promise<void> {
  if (this.gates[gateName]) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    if (!this.gateCallbacks.has(gateName)) {
      this.gateCallbacks.set(gateName, new Set());
    }
    this.gateCallbacks.get(gateName)!.add(resolve);
  });
}

public getGateStatus(): Readonly<typeof this.gates> {
  return { ...this.gates };
}
```

#### 6A.1.3: Update Teardown Logic

**File**: `client/src/lib/room-doc-manager.ts`

Update the destroy method (around line 576):

```typescript
destroy(): void {
  if (this.destroyed) return;
  this.destroyed = true;

  // Stop RAF loop
  if (this.publishState.rafId !== -1) {
    this.frames.cancel(this.publishState.rafId);
  }

  // Clear gate timeouts
  this.gateTimeouts.forEach(timeout => clearTimeout(timeout));
  this.gateTimeouts.clear();

  // Cleanup providers (Phase 6A additions)
  if (this.indexeddbProvider) {
    this.indexeddbProvider.destroy();
    this.indexeddbProvider = null;
  }

  if (this.websocketProvider) {
    // Phase 6C: will add proper WS cleanup (disconnect + destroy)
    // For now, just null the reference - actual cleanup added in 6C
    this.websocketProvider = null;
  }

  // ... rest of existing cleanup
}
```

### 6A.2: Boot Discipline & First-Paint Guarantees

#### 6A.2.1: Ensure EmptySnapshot is Available

This is already implemented in the constructor (line 164):

```typescript
this._currentSnapshot = createEmptySnapshot();
```

**IMPORTANT**: The RAF publisher loop should already be running from manager creation (implemented in Phase 2). This ensures the first doc-derived snapshot appears ≤ 1 rAF after any Y update (from IDB or WS). Do NOT wait for any gates to start the RAF loop.

#### 6A.2.2: Fix svKey Publishing Bug

**File**: `client/src/lib/room-doc-manager.ts`

**CRITICAL FIX**: Remove the svKey deduplication optimization from the RAF loop. The svKey truncation (first 100 bytes) misses local client updates when state vectors are large (>100 bytes), causing strokes not to render until page refresh.

**Update the RAF loop to always publish when dirty** (in `startPublishLoop` method, around line 710):

```typescript
private startPublishLoop(): void {
  const rafLoop = () => {
    // Publish if Y.Doc changed OR presence changed
    if (this.publishState.isDirty || this.publishState.presenceDirty) {
      const startTime = this.clock.now();

      // Build snapshot
      const newSnapshot = this.buildSnapshot();

      // CRITICAL FIX: Always publish when dirty, don't use svKey as a gate
      // The svKey truncation (first 100 bytes) was missing local client updates
      // when state vectors were large (>100 bytes), causing strokes to not render
      // until refresh. See PHASE_6A_DEBUG_REPORT.md for full details.
      this.publishSnapshot(newSnapshot);

      // Clear both dirty flags
      this.publishState.isDirty = false;
      this.publishState.presenceDirty = false;

      // Track timing for metrics
      this.publishState.lastPublishTime = this.clock.now();
      this.publishState.publishCostMs = this.clock.now() - startTime;
    }

    // Continue loop if not destroyed
    if (!this.destroyed) {
      this.publishState.rafId = this.frames.request(rafLoop);
    }
  };

  // Start the loop
  this.publishState.rafId = this.frames.request(rafLoop);
}
```

**What was removed**: The `svKeyChanged` comparison that was previously gating the `publishSnapshot` call. Now it always publishes when dirty, ensuring strokes render immediately.

### 6A.3: Client Config Validation with Zod

#### 6A.3.1: Create Config Schema

**File**: `client/src/lib/config-schema.ts` **(NEW FILE - Create this file)**

```typescript
import { z } from 'zod';

// Client configuration schema
export const ClientConfigSchema = z.object({
  VITE_WS_BASE: z.string().min(1, 'WebSocket base URL is required'),
  VITE_API_BASE: z.string().min(1, 'API base URL is required'),
  VITE_ROOM_TTL_DAYS: z.coerce.number().min(1).max(90).default(14),
  // Add other client-side configs as needed
});

export type ClientConfig = z.infer<typeof ClientConfigSchema>;

// Validation function with error handling
export function loadClientConfig(): ClientConfig {
  try {
    const config = {
      VITE_WS_BASE: import.meta.env.VITE_WS_BASE || '/ws',
      VITE_API_BASE: import.meta.env.VITE_API_BASE || '/api',
      VITE_ROOM_TTL_DAYS: Number(import.meta.env.VITE_ROOM_TTL_DAYS ?? 14),
    };

    return ClientConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('[Config] Validation failed:', error.errors);
      // Show user-friendly error (this would be rendered in UI)
      throw new Error(`Configuration error: ${error.errors[0].message}`);
    }
    throw error;
  }
}

// Export validated config instance
export const clientConfig = loadClientConfig();
```

### 6A.4: Minimal "Recent Rooms" Readiness

**File**: `client/src/lib/room-doc-manager.ts`

Add a public method to check IDB readiness:

```typescript
public isIndexedDBReady(): boolean {
  return this.gates.idbReady;
}
```
