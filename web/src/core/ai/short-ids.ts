import { AI_SHORT_ID_RE } from '@avlo/shared';
import { getVisibleBoundsTuple } from '@/stores/camera-store';

/**
 * Per-conversation id + coordinate translation (tldraw's SimpleIds /
 * chat-origin model). The model NEVER sees ULIDs or raw world coordinates:
 *
 *  - Existing objects get sequential short ids (`s1`, `s2`, …) assigned by the
 *    context serializer on first sight; the bidirectional map lives for the
 *    whole conversation so ids stay stable across turns.
 *  - Model-minted ids (creations) are registered by the executor against the
 *    real ULIDs it mints. An unknown short id resolves to undefined and the
 *    referencing action is DROPPED — never guessed at.
 *  - Coordinates translate between world space and "chat space": integers
 *    relative to a fixed origin captured from the viewport center on first
 *    use. Per-CONVERSATION (not per-request) so numbers stay stable and small
 *    across a whole session.
 *
 * Module-level singleton — one conversation is active at a time (the panel is
 * per-room, remounted on room change). `resetAiConversation()` on room switch
 * and on clear-history.
 */

const shortByUlid = new Map<string, string>();
const ulidByShort = new Map<string, string>();
let nextShort = 1;
let chatOrigin: [number, number] | null = null;
let boundRoomId: string | null = null;

export function resetAiConversation(): void {
  shortByUlid.clear();
  ulidByShort.clear();
  nextShort = 1;
  chatOrigin = null;
}

/**
 * Bind the conversation state to a room — resets ONLY on room change, so
 * closing/reopening the panel in the same room keeps the map (the server
 * conversation persists in the agent DO). A page reload loses the map by
 * nature; the model recovers by re-reading via canvas_read (documented in
 * docs/ai/protocol.md).
 */
export function bindAiConversation(roomId: string): void {
  if (boundRoomId === roomId) return;
  boundRoomId = roomId;
  resetAiConversation();
}

/** Chat origin: viewport center at first use, snapped to ints. Fixed thereafter. */
function origin(): [number, number] {
  if (!chatOrigin) {
    const vp = getVisibleBoundsTuple();
    chatOrigin = [Math.round((vp[0] + vp[2]) / 2), Math.round((vp[1] + vp[3]) / 2)];
  }
  return chatOrigin;
}

export function worldToChatX(x: number): number {
  return Math.round(x - origin()[0]);
}
export function worldToChatY(y: number): number {
  return Math.round(y - origin()[1]);
}
export function chatToWorldX(x: number): number {
  return x + origin()[0];
}
export function chatToWorldY(y: number): number {
  return y + origin()[1];
}

/** Short id for an existing object — assigns on first sight (serializer path). */
export function shortIdFor(ulid: string): string {
  let sid = shortByUlid.get(ulid);
  if (!sid) {
    sid = `s${nextShort++}`;
    shortByUlid.set(ulid, sid);
    ulidByShort.set(sid, ulid);
  }
  return sid;
}

/** Resolve a model-referenced short id. undefined ⇒ drop the action. */
export function ulidFor(shortId: string): string | undefined {
  return ulidByShort.get(shortId);
}

/**
 * Register a model-minted short id against the real ULID the executor minted.
 * Returns false when the short id is malformed or already taken (the model
 * reused an id) — the create is dropped rather than silently remapped.
 */
export function registerCreated(shortId: string, ulid: string): boolean {
  if (!AI_SHORT_ID_RE.test(shortId) || ulidByShort.has(shortId)) return false;
  // Keep the sequence ahead of model-minted numbers so serializer-assigned
  // ids can never collide with the model's numbering.
  const n = Number.parseInt(shortId.slice(1), 10);
  if (n >= nextShort) nextShort = n + 1;
  ulidByShort.set(shortId, ulid);
  shortByUlid.set(ulid, shortId);
  return true;
}
