/**
 * Presence — awareness lifecycle, cursor send/receive.
 *
 * Provider-owned awareness: YProvider creates the Awareness instance,
 * we attach to it via `attach(provider)` and detach via `detach()`.
 * All module-level state lives here. CursorAnimationJob reads
 * `getPeerCursors()` directly — zero Zustand overhead per frame.
 */

import type { Awareness as YAwareness } from 'y-protocols/awareness';
import type YProvider from 'y-partyserver/provider';
import { usePresenceStore, type PeerIdentity } from '@/stores/presence-store';
import { getUserProfile } from '@/stores/device-ui-store';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { isMobile } from '@/stores/camera-store';
import { clearBitmapCache } from '@/renderer/animation/cursor-bitmap';

// ─── Types ───────────────────────────────────────────────────────────

export interface PeerCursorState {
  userId: string;
  name: string;
  color: string;
  target: [number, number];
  display: [number, number];
  hasCursor: boolean;
  isSettled: boolean;
}

// ─── Module State ────────────────────────────────────────────────────

// Lifecycle
let currentAwareness: YAwareness | null = null;
let currentProvider: YProvider | null = null;
let cachedLocalClientId = -1;
let updateHandler: ((changes: { added: number[]; updated: number[]; removed: number[] }) => void) | null = null;
let statusHandler: ((event: { status: string }) => void) | null = null;

// Send
let dirty = false;
let timer: number | null = null;
let connected = false;
let identitySent = false;
let localCursor: [number, number] | undefined;
let lastSentCursor: [number, number] | undefined;

const THROTTLE_MS = 50;
const BACKPRESSURE_HIGH = 128 * 1024;
const BACKPRESSURE_CRITICAL = 512 * 1024;

// Receive
const peerCursors = new Map<number, PeerCursorState>();

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

  updateHandler = (changes: { added: number[]; updated: number[]; removed: number[] }) => {
    const hadPeers = peerCursors.size > 0;
    processBatch(
      changes.added || [],
      changes.updated || [],
      changes.removed || [],
      (clientId) => awareness.getStates().get(clientId) as Record<string, unknown> | undefined,
    );
    // Only invalidate overlay if there are (or were) remote cursors to draw
    if (peerCursors.size > 0 || hadPeers) {
      invalidateOverlay();
    }
  };

  awareness.on('update', updateHandler);

  statusHandler = (event: { status: string }) => {
    if (event.status === 'connected') {
      // Clear stale peers from previous connection —
      // awareness sync from DO will repopulate current ones
      peerCursors.clear();
      rebuildStore();

      connected = true;
      sendFullState();
      if (dirty) scheduleSend();
      onStatusChange?.(true);
    } else if (event.status === 'disconnected') {
      connected = false;
      localCursor = undefined;
      lastSentCursor = undefined;
      identitySent = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      dirty = false;

      // Clear peer state immediately on disconnect
      peerCursors.clear();
      rebuildStore();

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
      (currentProvider as any).off?.('status', statusHandler);
    } catch {
      /* ignore */
    }
    statusHandler = null;
  }

  // 4. Reset send state
  identitySent = false;
  localCursor = undefined;
  lastSentCursor = undefined;

  // 5. Reset receive state
  peerCursors.clear();
  rebuildStore();
  clearBitmapCache();

  currentAwareness = null;
  currentProvider = null;
  cachedLocalClientId = -1;
}

// ─── Send ────────────────────────────────────────────────────────────

export function updateCursor(worldX: number, worldY: number): void {
  if (!currentAwareness) return;

  const x = Math.round(worldX);
  const y = Math.round(worldY);

  if (localCursor && localCursor[0] === x && localCursor[1] === y) return;
  localCursor = [x, y];

  if (peerCursors.size === 0) return;

  dirty = true;
  scheduleSend();
}

export function clearCursor(): void {
  if (!localCursor) return;
  localCursor = undefined;
  dirty = true;
  scheduleSend();
}

function scheduleSend(): void {
  if (timer !== null || !connected) return;
  timer = window.setTimeout(flush, THROTTLE_MS);
}

function flush(): void {
  timer = null;
  if (!connected || !dirty || !currentAwareness) return;

  const cursorSame =
    (!localCursor && !lastSentCursor) ||
    (localCursor && lastSentCursor && localCursor[0] === lastSentCursor[0] && localCursor[1] === lastSentCursor[1]);

  if (cursorSame && identitySent) {
    dirty = false;
    return;
  }

  const throttleMs = getBackpressureDelay();
  if (throttleMs > 0) {
    timer = window.setTimeout(flush, throttleMs);
    return;
  }

  const cursor = isMobile() ? undefined : localCursor ? { x: localCursor[0], y: localCursor[1] } : undefined;

  currentAwareness.setLocalStateField('cursor', cursor);
  lastSentCursor = localCursor ? [localCursor[0], localCursor[1]] : undefined;
  dirty = false;
}

function getBackpressureDelay(): number {
  try {
    const ws: WebSocket | undefined = (currentProvider as any)?.ws;
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
    cursor: localCursor ? { x: localCursor[0], y: localCursor[1] } : undefined,
  });
  identitySent = true;
  lastSentCursor = localCursor ? [localCursor[0], localCursor[1]] : undefined;
  dirty = false;
}

// ─── Receive ─────────────────────────────────────────────────────────

export function getPeerCursors(): ReadonlyMap<number, PeerCursorState> {
  return peerCursors;
}

function processBatch(
  added: number[],
  updated: number[],
  removed: number[],
  getState: (clientId: number) => Record<string, unknown> | undefined,
): void {
  let identityDirty = false;

  for (const clientId of added) {
    if (clientId === cachedLocalClientId) continue;
    if (processUpsert(clientId, getState(clientId))) identityDirty = true;
  }
  for (const clientId of updated) {
    if (clientId === cachedLocalClientId) continue;
    if (processUpsert(clientId, getState(clientId))) identityDirty = true;
  }

  for (const clientId of removed) {
    if (clientId === cachedLocalClientId) continue;
    if (peerCursors.has(clientId)) {
      peerCursors.delete(clientId);
      identityDirty = true;
    }
  }

  if (identityDirty) rebuildStore();
}

function processUpsert(clientId: number, state: Record<string, unknown> | undefined): boolean {
  if (!state || !state.userId) return false;

  const userId = state.userId as string;
  const name = (state.name as string) || 'Anonymous';
  const color = (state.color as string) || '#808080';
  const cursor = state.cursor as { x: number; y: number } | undefined;

  let peer = peerCursors.get(clientId);
  let identityChanged = false;

  if (!peer) {
    const tx = cursor ? Math.round(cursor.x) : 0;
    const ty = cursor ? Math.round(cursor.y) : 0;
    peer = {
      userId,
      name,
      color,
      target: [tx, ty],
      display: [tx, ty],
      hasCursor: !!cursor,
      isSettled: true,
    };
    peerCursors.set(clientId, peer);
    identityChanged = true;
  } else {
    if (peer.name !== name || peer.color !== color || peer.userId !== userId) {
      peer.userId = userId;
      peer.name = name;
      peer.color = color;
      identityChanged = true;
    }
  }

  if (cursor) {
    const tx = Math.round(cursor.x);
    const ty = Math.round(cursor.y);
    if (!peer.hasCursor) {
      peer.display[0] = tx;
      peer.display[1] = ty;
    }
    peer.target[0] = tx;
    peer.target[1] = ty;
    peer.hasCursor = true;
    peer.isSettled = false;
  } else {
    peer.hasCursor = false;
  }

  return identityChanged;
}

function rebuildStore(): void {
  const identities = new Map<string, PeerIdentity>();
  for (const peer of peerCursors.values()) {
    identities.set(peer.userId, { name: peer.name, color: peer.color });
  }
  usePresenceStore.getState().setPeers(identities);
}
