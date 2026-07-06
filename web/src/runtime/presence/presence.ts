/**
 * Presence — awareness lifecycle, cursor send/receive.
 *
 * Provider-owned awareness: YProvider creates the Awareness instance,
 * we attach to it via `attach(provider)` and detach via `detach()`.
 * Peer-state ownership lives in the `PresenceCursorRenderer` module-level
 * singleton — this file keeps the send path, receive dispatch, and lifecycle.
 */

import type YProvider from 'y-partyserver/provider';
import type { Awareness as YAwareness } from 'y-protocols/awareness';
import { getUserProfile } from '@/stores/auth-store';
import { isMobile } from '@/stores/camera-store';
import { PresenceCursorRenderer } from './presence-renderer';

// ─── Module State ────────────────────────────────────────────────────

// Lifecycle
let currentAwareness: YAwareness | null = null;
let currentProvider: YProvider | null = null;
let cachedLocalClientId = -1;
let updateHandler: ((changes: { added: number[]; updated: number[]; removed: number[] }) => void) | null = null;
let statusHandler: ((event: { status: string }) => void) | null = null;
let cursorRenderer: PresenceCursorRenderer | null = null;

// Send
let dirty = false;
let timer: number | null = null;
let connected = false;
let identitySent = false;
const localCursor: [number, number] = [0, 0];
let hasLocalCursor = false;
const lastSentCursor: [number, number] = [0, 0];
let hasLastSentCursor = false;

const THROTTLE_MS = 50;
const BACKPRESSURE_HIGH = 128 * 1024;
const BACKPRESSURE_CRITICAL = 512 * 1024;

// ─── Lifecycle ───────────────────────────────────────────────────────

/**
 * Attach to the provider's awareness. Wires update handler + WS status handler.
 * Called after YProvider is created — awareness is owned by the provider.
 */
export function attach(provider: YProvider, onStatusChange?: (connected: boolean) => void): void {
  currentProvider = provider;
  const awareness = provider.awareness;
  currentAwareness = awareness;
  cachedLocalClientId = awareness.clientID;

  cursorRenderer = new PresenceCursorRenderer(cachedLocalClientId);
  cursorRenderer.attach();

  updateHandler = (changes: { added: number[]; updated: number[]; removed: number[] }) => {
    if (!cursorRenderer) return;
    const hadActive = cursorRenderer.hasActivePeers();
    cursorRenderer.processAwarenessBatch(
      changes.added || [],
      changes.updated || [],
      changes.removed || [],
      (cid) => awareness.getStates().get(cid) as Record<string, unknown> | undefined,
    );
    const hasActive = cursorRenderer.hasActivePeers();
    // Solo→Join catch-up: the alone-optimization stored our cursor locally but
    // didn't broadcast. Flush now that a peer can see it.
    if (hasActive && !hadActive && hasLocalCursor) {
      dirty = true;
      scheduleSend();
    }
  };

  awareness.on('update', updateHandler);

  statusHandler = (event: { status: string }) => {
    if (event.status === 'connected') {
      // Clear stale peers from previous connection — awareness sync from DO
      // will repopulate current ones.
      cursorRenderer?.clearAllPeers();

      connected = true;
      sendFullState();
      if (dirty) scheduleSend();
      onStatusChange?.(true);
    } else if (event.status === 'disconnected') {
      connected = false;
      hasLocalCursor = false;
      hasLastSentCursor = false;
      identitySent = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      dirty = false;

      // Clear peer visuals immediately on disconnect.
      cursorRenderer?.clearAllPeers();

      try {
        awareness.setLocalState(null);
      } catch {
        // Ignore errors during cleanup
      }

      onStatusChange?.(false);
    }
  };

  provider.on('status', statusHandler);
}

/**
 * Detach from provider's awareness. Signals departure, removes listeners,
 * resets all module state. Does NOT destroy awareness — provider owns it,
 * and y-protocols auto-destroys awareness on doc.destroy().
 */
export function detach(): void {
  // 1. Stop sending first (prevent flush() during teardown)
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  dirty = false;
  connected = false;

  // 2. Signal departure (while WS may still be open)
  const awareness = currentAwareness;
  if (awareness) {
    try {
      awareness.setLocalState(null);
    } catch {
      /* ignore */
    }
  }

  // 3. Unregister listeners
  if (awareness && updateHandler) {
    awareness.off('update', updateHandler);
    updateHandler = null;
  }
  if (currentProvider && statusHandler) {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: upstream-type — provider adapter's optional `off` method is not in the public type; duck-typed at teardown
      (currentProvider as any).off?.('status', statusHandler);
    } catch {
      /* ignore */
    }
    statusHandler = null;
  }

  // 4. Reset send state
  identitySent = false;
  hasLocalCursor = false;
  hasLastSentCursor = false;

  // 5. Dispose renderer — frees slots, revokes blob URLs, empties peer store.
  if (cursorRenderer) {
    cursorRenderer.dispose();
    cursorRenderer = null;
  }

  currentAwareness = null;
  currentProvider = null;
  cachedLocalClientId = -1;
}

/**
 * Replay current awareness state into the renderer. Closes the refresh race:
 * `connectRoom` (route `beforeLoad`) wires awareness BEFORE `Canvas` mounts and
 * registers `cursorHost`, so any peer whose state arrived in that window was
 * dropped by `allocSlot` (host still null). `CanvasRuntime.start` calls this
 * once the host is live — re-adding those peers (identity → avatar cluster +
 * their last-known cursor) and flushing a parked local cursor if we'd wrongly
 * gone solo. Idempotent: an empty room returns early; a live slot is a no-op.
 */
export function resyncPeersFromAwareness(): void {
  const awareness = currentAwareness;
  if (!awareness || !cursorRenderer) return;

  const states = awareness.getStates();
  const ids: number[] = [];
  for (const cid of states.keys()) {
    if (cid !== cachedLocalClientId) ids.push(cid);
  }
  if (ids.length === 0) return;

  const hadActive = cursorRenderer.hasActivePeers();
  cursorRenderer.processAwarenessBatch(ids, [], [], (cid) => states.get(cid) as Record<string, unknown> | undefined);

  // Solo→Join catch-up: if the pointer moved during the pre-mount window then
  // stopped, the cursor is parked locally (alone-optimization) — flush it now
  // that a peer is visible. No-op if the pointer never moved (nothing to send).
  if (cursorRenderer.hasActivePeers() && !hadActive && hasLocalCursor) {
    dirty = true;
    scheduleSend();
  }
}

// ─── Send ────────────────────────────────────────────────────────────

export function updateCursor(worldX: number, worldY: number): void {
  if (!currentAwareness) return;

  const x = Math.round(worldX);
  const y = Math.round(worldY);

  if (hasLocalCursor && localCursor[0] === x && localCursor[1] === y) return;
  localCursor[0] = x;
  localCursor[1] = y;
  hasLocalCursor = true;

  if (!cursorRenderer?.hasActivePeers()) return;

  dirty = true;
  scheduleSend();
}

export function clearCursor(): void {
  if (!hasLocalCursor) return;
  hasLocalCursor = false;
  dirty = true;
  scheduleSend();
}

function scheduleSend(): void {
  if (timer !== null || !connected) return;
  timer = window.setTimeout(flush, THROTTLE_MS);
}

/** Snapshot `localCursor` → `lastSentCursor` in place after a wire send (or clear). */
function markCursorSent(): void {
  if (hasLocalCursor) {
    lastSentCursor[0] = localCursor[0];
    lastSentCursor[1] = localCursor[1];
    hasLastSentCursor = true;
  } else {
    hasLastSentCursor = false;
  }
}

function flush(): void {
  timer = null;
  if (!connected || !dirty || !currentAwareness) return;

  const cursorSame =
    (!hasLocalCursor && !hasLastSentCursor) ||
    (hasLocalCursor && hasLastSentCursor && localCursor[0] === lastSentCursor[0] && localCursor[1] === lastSentCursor[1]);

  if (cursorSame && identitySent) {
    dirty = false;
    return;
  }

  const throttleMs = getBackpressureDelay(currentProvider);
  if (throttleMs > 0) {
    timer = window.setTimeout(flush, throttleMs);
    return;
  }

  const cursor = isMobile() ? undefined : hasLocalCursor ? { x: localCursor[0], y: localCursor[1] } : undefined;

  currentAwareness.setLocalStateField('cursor', cursor);
  markCursorSent();
  dirty = false;
}

/** Shared with core/locks/lock-protocol.ts — both throttle against the same socket buffer. */
export function getBackpressureDelay(provider: YProvider | null): number {
  try {
    const ws = provider?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return 0;
    const buf = ws.bufferedAmount ?? 0;
    if (buf > BACKPRESSURE_CRITICAL) return 200;
    if (buf > BACKPRESSURE_HIGH) return 100;
  } catch {
    // Ignore — proceed normally
  }
  return 0;
}

function sendFullState(): void {
  if (!currentAwareness) return;
  const identity = getUserProfile();
  currentAwareness.setLocalState({
    userId: identity.userId,
    name: identity.name,
    color: identity.color,
    cursor: hasLocalCursor ? { x: localCursor[0], y: localCursor[1] } : undefined,
  });
  identitySent = true;
  markCursorSent();
  dirty = false;
}
