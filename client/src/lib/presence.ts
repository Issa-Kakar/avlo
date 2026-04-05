/**
 * Presence — awareness lifecycle, cursor send/receive.
 *
 * Consolidates awareness init, send, and receive into a single module.
 * All module-level state lives here. CursorAnimationJob reads
 * `getPeerCursors()` directly — zero Zustand overhead per frame.
 */

import { Awareness as YAwareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type YProvider from 'y-partyserver/provider';
import { usePresenceStore, type PeerIdentity } from '@/stores/presence-store';
import { userProfileManager } from '@/lib/user-profile-manager';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import { isMobile } from '@/stores/camera-store';
import { clearBitmapCache } from '@/canvas/animation/cursor-bitmap';

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
let changeHandler: ((changes: { added: number[]; updated: number[]; removed: number[] }) => void) | null = null;
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

export function createAwareness(ydoc: Y.Doc): YAwareness {
  const awareness = new YAwareness(ydoc);
  currentAwareness = awareness;

  const identity = userProfileManager.getIdentity();
  usePresenceStore.getState().setLocalUserId(identity.userId);

  return awareness;
}

export function getAwareness(): YAwareness | null {
  return currentAwareness;
}

/**
 * Attach awareness change listener + WS status handler.
 * Called after WS provider is created.
 *
 * Optional `onStatusChange` callback replaces the duplicate
 * `provider.on('status', ...)` in room-doc-manager.
 */
export function attachListeners(
  awareness: YAwareness,
  provider: YProvider,
  onStatusChange?: (connected: boolean) => void,
): void {
  currentProvider = provider;
  cachedLocalClientId = awareness.clientID;

  changeHandler = (changes: { added: number[]; updated: number[]; removed: number[] }) => {
    processBatch(
      changes.added || [],
      changes.updated || [],
      changes.removed || [],
      (clientId) => awareness.getStates().get(clientId) as Record<string, unknown> | undefined,
    );
    invalidateOverlay();
  };

  awareness.on('change', changeHandler);

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
 * Detach listeners, signal departure, destroy awareness.
 */
export function detachAndDestroy(awareness: YAwareness, provider: YProvider | null): void {
  // Signal departure
  try {
    awareness.setLocalState(null);
  } catch {
    // Ignore
  }

  // Unregister listeners
  if (changeHandler) {
    awareness.off('change', changeHandler);
    changeHandler = null;
  }

  if (provider && statusHandler) {
    try {
      (provider as any).off?.('status', statusHandler);
    } catch {
      // Ignore
    }
    statusHandler = null;
  }

  // Destroy awareness
  try {
    if (typeof (awareness as any).destroy === 'function') {
      (awareness as any).destroy();
    }
  } catch {
    // Ignore
  }

  // Reset send state
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  dirty = false;
  connected = false;
  identitySent = false;
  localCursor = undefined;
  lastSentCursor = undefined;

  // Reset receive state
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

  if (usePresenceStore.getState().isAlone) return;

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
    (localCursor &&
      lastSentCursor &&
      localCursor[0] === lastSentCursor[0] &&
      localCursor[1] === lastSentCursor[1]);

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
  const identity = userProfileManager.getIdentity();
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

function processUpsert(
  clientId: number,
  state: Record<string, unknown> | undefined,
): boolean {
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
