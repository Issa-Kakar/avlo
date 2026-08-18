import { decodeLockPeerSetBody, encodeLockSet, LOCK_LEASE_MS, MSG_LOCK } from '@avlo/shared';
import type YProvider from 'y-partyserver/provider';
import { getBackpressureDelay } from '@/runtime/presence/presence';
import { applyPeerSet, clearAllRemote, getLocalLockedIdSet, onLocalLocksChanged } from './lock-table';

/**
 * Wire plumbing for ephemeral locks — the provider hook, receive buffering, and the
 * throttled/leased egress. Mirrors presence.ts's module shape (state + attach/detach).
 *
 * Receive: `provider.messageHandlers[MSG_LOCK]` (per-instance array; types 0-3 are Yjs).
 * The server's connect snapshot lands after syncStep1 but always BEFORE our `synced` flips,
 * when ids can't intern yet — frames buffer until the 'sync' event, keyed per peer (full-
 * replace makes last-wins coalescing correct). After sync, per-connection TCP ordering
 * guarantees a peer's object-creation update precedes any lock on it from that peer.
 *
 * Send: full-replace LOCK_SET on local change. Releases flush immediately (peers unblock
 * fast); growth (eraser sweeps) coalesces to ≤1 frame per 50ms. While holding ≥1 lock, an
 * unchanged resend goes out every LOCK_LEASE_MS — the server-side lease that survives DO
 * hibernation amnesia. Sends happen even when alone: the server must hold state for late
 * joiners (its broadcast loop naturally reaches nobody).
 */

const SEND_COALESCE_MS = 50;

let currentProvider: YProvider | null = null;
let pending: Map<number, string[]> | null = null; // non-null = buffering until sync
let connected = false;
let dirty = false;
let throttleTimer: number | null = null;
let leaseTimer: number | null = null;
let syncHandler: ((isSynced: boolean) => void) | null = null;
let statusHandler: ((event: { status: string }) => void) | null = null;

// Registered once for the module's lifetime — no-ops while detached (currentProvider null).
onLocalLocksChanged((shrank) => {
  if (currentProvider === null) return;
  if (!connected) {
    dirty = true; // re-announced on the next 'connected'
    return;
  }
  if (shrank) {
    sendNow();
    return;
  }
  dirty = true;
  if (throttleTimer === null) throttleTimer = window.setTimeout(flush, SEND_COALESCE_MS);
});

/** Called from RoomDocManager.initializeWebSocketProvider, synchronously post-construction. */
export function attachLocks(provider: YProvider): void {
  currentProvider = provider;
  pending = new Map();

  provider.messageHandlers[MSG_LOCK] = (_encoder, decoder) => {
    // Trusted input (our own server). Writing nothing to the reply encoder → nothing echoed.
    const [ownerKey, ids] = decodeLockPeerSetBody(decoder);
    if (pending !== null) pending.set(ownerKey, ids);
    else applyPeerSet(ownerKey, ids);
  };

  syncHandler = (isSynced: boolean) => {
    if (isSynced) {
      if (pending !== null) {
        for (const [ownerKey, ids] of pending) applyPeerSet(ownerKey, ids);
        pending = null;
      }
    } else {
      pending = new Map(); // socket dropped — buffer again until the next sync completes
    }
  };
  provider.on('sync', syncHandler);

  statusHandler = (event: { status: string }) => {
    if (event.status === 'connected') {
      connected = true;
      // Stale prior-connection owners (keys recycle per connection); fresh snapshot incoming.
      clearAllRemote();
      // Re-announce — covers reconnect mid-gesture and DO hibernation amnesia.
      if (dirty || getLocalLockedIdSet().size > 0) sendNow();
    } else if (event.status === 'disconnected') {
      connected = false;
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      dirty = false;
      clearAllRemote();
      // Re-arm buffering from the drop itself — don't rely on the provider
      // emitting sync(false) (an undocumented cross-package contract). The
      // reconnect snapshot must never apply before ids can intern.
      pending = new Map();
    }
  };
  provider.on('status', statusHandler);

  leaseTimer = window.setInterval(() => {
    if (!connected) return;
    // Holding ≥1 → the lease resend. Dirty with an empty set → a release whose send
    // failed (socket mid-reconnect); retry until it actually leaves the machine.
    if (dirty || getLocalLockedIdSet().size > 0) sendNow();
  }, LOCK_LEASE_MS);
}

/** Called from RoomDocManager.destroy() beside presence detach(), before provider disposal. */
export function detachLocks(): void {
  if (throttleTimer !== null) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  if (leaseTimer !== null) {
    clearInterval(leaseTimer);
    leaseTimer = null;
  }
  const provider = currentProvider;
  if (provider !== null) {
    if (syncHandler !== null) provider.off('sync', syncHandler);
    if (statusHandler !== null) provider.off('status', statusHandler);
  }
  syncHandler = null;
  statusHandler = null;
  currentProvider = null;
  pending = null;
  connected = false;
  dirty = false;
  clearAllRemote(); // no farewell frame — the server releases on close
}

function flush(): void {
  throttleTimer = null;
  if (!connected || !dirty) return;
  const delay = getBackpressureDelay(currentProvider);
  if (delay > 0) {
    throttleTimer = window.setTimeout(flush, delay);
    return;
  }
  sendNow();
}

function sendNow(): void {
  if (throttleTimer !== null) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  // Dirty clears ONLY on a confirmed send. A release skipped on a mid-reconnect socket
  // would otherwise be lost forever: the local set is already empty, so nothing would
  // re-announce and the server would hold the lock until its lazy sweep — which never
  // runs on an idle room. Failed sends retry via the lease tick / flush / 'connected'.
  dirty = !sendCurrent();
}

/** True when a frame actually went out over an OPEN socket. */
function sendCurrent(): boolean {
  const ws = currentProvider?.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(encodeLockSet(getLocalLockedIdSet()));
  } catch {
    return false; // racing close between the readyState read and the send
  }
  return true;
}
