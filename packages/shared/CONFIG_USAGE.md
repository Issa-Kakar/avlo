# Config Module Usage Guide

## Overview

All Avlo constants are centralized in `packages/shared/src/config.ts` as specified in the global conventions. This ensures consistency across the codebase and allows for environment-based overrides.

## Usage Examples

### Importing Config in TypeScript/JavaScript

```typescript
// Import specific config groups
import { ROOM_CONFIG, STROKE_CONFIG } from '@avlo/shared';

// Import the default CONFIG object
import CONFIG from '@avlo/shared';

// Import utility functions
import { isRoomReadOnly, calculateAwarenessInterval } from '@avlo/shared';
```

### Common Usage Patterns

#### 1. Checking Room Size Limits

```typescript
import { isRoomSizeWarning, isRoomReadOnly } from '@avlo/shared';

function checkRoomStatus(sizeBytes: number) {
  if (isRoomReadOnly(sizeBytes)) {
    // Block all writes
    return 'read-only';
  } else if (isRoomSizeWarning(sizeBytes)) {
    // Show warning pill
    return 'warning';
  }
  return 'ok';
}
```

#### 2. Using Stroke Limits

```typescript
import { STROKE_CONFIG } from '@avlo/shared';

function validateStroke(points: number[]) {
  const pointCount = points.length / 2; // x,y pairs

  if (pointCount > STROKE_CONFIG.MAX_POINTS_PER_STROKE) {
    throw new Error(`Stroke exceeds maximum of ${STROKE_CONFIG.MAX_POINTS_PER_STROKE} points`);
  }

  // Apply simplification tolerance
  const tolerance =
    tool === 'pen'
      ? STROKE_CONFIG.PEN_SIMPLIFICATION_TOLERANCE
      : STROKE_CONFIG.HIGHLIGHTER_SIMPLIFICATION_TOLERANCE;
}
```

#### 3. WebRTC Configuration

```typescript
import { WEBRTC_CONFIG, calculateAwarenessInterval } from '@avlo/shared';

function shouldStartWebRTC(peerCount: number) {
  return peerCount <= WEBRTC_CONFIG.WEBRTC_START_THRESHOLD;
}

function getAwarenessRate(peerCount: number, isRTC: boolean) {
  if (isRTC) {
    return WEBRTC_CONFIG.AWARENESS_HZ_BASE_RTC;
  }

  // Calculate dynamic interval based on peer count
  const intervalMs = calculateAwarenessInterval(peerCount);
  return 1000 / intervalMs; // Convert to Hz
}
```

#### 4. Backoff and Retry Logic

```typescript
import { BACKOFF_CONFIG, applyJitter } from '@avlo/shared';

class WebSocketReconnect {
  private retryCount = 0;

  getNextDelay(): number {
    const base = BACKOFF_CONFIG.WS_BASE_MS;
    const delay = Math.min(base * Math.pow(2, this.retryCount), BACKOFF_CONFIG.WS_MAX_MS);

    // Apply jitter to prevent thundering herd
    return applyJitter(delay, BACKOFF_CONFIG.WS_JITTER);
  }

  resetOnStableConnection(connectionDuration: number) {
    if (connectionDuration > BACKOFF_CONFIG.WS_STABLE_CONNECTION_MS) {
      this.retryCount = 0;
    }
  }
}
```

#### 5. Performance Budgets

```typescript
import { PERFORMANCE_CONFIG } from '@avlo/shared';

class RenderLoop {
  private lastFrameTime = 0;

  shouldRender(): boolean {
    const elapsed = performance.now() - this.lastFrameTime;
    const targetFPS = document.hidden
      ? PERFORMANCE_CONFIG.HIDDEN_TAB_FPS
      : PERFORMANCE_CONFIG.MAX_FPS;

    const targetInterval = 1000 / targetFPS;
    return elapsed >= targetInterval;
  }

  getRenderBudget(): number {
    return PERFORMANCE_CONFIG.RENDER_BUDGET_MS;
  }
}
```

## Environment Variable Overrides

Any constant can be overridden via environment variables. The naming convention is:

- Use the constant name as-is
- Set in `.env` file or system environment

```bash
# .env
ROOM_TTL_DAYS=7                    # Override default 14 days
MAX_CLIENTS_PER_ROOM=50            # Override default 105
AWARENESS_HZ_BASE_RTC=30           # Override default 25 Hz
```

## Config Groups

### Core Configuration Groups

- **ROOM_CONFIG**: Room persistence, size limits, capacity
- **STROKE_CONFIG**: Drawing limits, simplification, opacity
- **TEXT_CONFIG**: Text and code execution limits
- **WEBRTC_CONFIG**: Peer-to-peer settings, awareness rates
- **BACKOFF_CONFIG**: Reconnection and retry parameters
- **RATE_LIMIT_CONFIG**: API and action throttling
- **PERFORMANCE_CONFIG**: FPS, rendering budgets, export settings
- **QUEUE_CONFIG**: Write queue and persistence batching
- **OFFLINE_THRESHOLD_CONFIG**: Offline delta limits
- **PWA_CONFIG**: Service Worker cache settings
- **SERVER_CONFIG**: Server and database configuration
- **PROTOCOL_CONFIG**: Protocol versions
- **DEBUG_CONFIG**: Development and debugging flags

## Best Practices

1. **Always import from @shared/config**

   ```typescript
   // Good
   import { ROOM_CONFIG } from '@avlo/shared';

   // Bad - don't hardcode values
   const MAX_CLIENTS = 105; // Don't do this!
   ```

2. **Use utility functions when available**

   ```typescript
   // Good
   import { isRoomReadOnly } from '@avlo/shared';

   // Less ideal - manual comparison
   if (sizeBytes >= 10 * 1024 * 1024) {
   }
   ```

3. **Type safety with config types**

   ```typescript
   import type { RoomConfig, StrokeConfig } from '@avlo/shared';

   function processWithConfig(room: RoomConfig, stroke: StrokeConfig) {
     // TypeScript ensures correct config shape
   }
   ```

4. **Environment-specific overrides**

   ```typescript
   // Use DEBUG_CONFIG for development features
   import { DEBUG_CONFIG } from '@avlo/shared';

   if (DEBUG_CONFIG.ENABLE_PROFILING) {
     performance.mark('render-start');
   }
   ```

## Testing with Config

```typescript
// In tests, you can rely on consistent default values
import { ROOM_CONFIG } from '@avlo/shared';

describe('Room limits', () => {
  it('should enforce size limits', () => {
    const testSize = ROOM_CONFIG.ROOM_SIZE_WARNING_BYTES + 1;
    expect(isRoomSizeWarning(testSize)).toBe(true);
  });
});
```

## Phase-Specific Usage

Different config groups become relevant in different phases:

- **Phase 1-2**: Basic SERVER_CONFIG
- **Phase 3**: STROKE_CONFIG, PERFORMANCE_CONFIG
- **Phase 4**: WEBRTC_CONFIG, BACKOFF_CONFIG
- **Phase 5**: ROOM_CONFIG, QUEUE_CONFIG, RATE_LIMIT_CONFIG
- **Phase 6**: TEXT_CONFIG (UI components)
- **Phase 7**: TEXT_CONFIG (code execution)
- **Phase 8**: PWA_CONFIG
- **Phase 9**: Advanced WEBRTC_CONFIG
- **Phase 10**: Full production config with monitoring

## Debugging

To see active configuration:

```typescript
import CONFIG from '@avlo/shared';

// Log all active configuration (development only)
if (CONFIG.DEBUG.DEBUG_MODE) {
  console.log('Active configuration:', CONFIG);
}
```

## Migration from Hardcoded Values

When refactoring existing code:

```typescript
// Before
const roomSize = 10485760; // 10 MB

// After
import { ROOM_CONFIG } from '@avlo/shared';
const roomSize = ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES;
```

This ensures all constants are centralized and can be configured via environment variables as needed.
