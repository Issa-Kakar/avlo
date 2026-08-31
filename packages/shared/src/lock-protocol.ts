import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/**
 * Ephemeral object-lock wire protocol — shared by the client provider hook and the sync DO.
 *
 * Binary frames on the Yjs WebSocket, discriminated by the leading varuint:
 *   C→S  LOCK_SET       [MSG_LOCK][count][count × varstring id]            full replace of MY set; 0 = release all
 *   S→C  LOCK_PEER_SET  [MSG_LOCK][ownerKey ≥ 2][count][count × varstring id]  full replace of ONE peer's granted set
 *
 * MSG_LOCK must stay in 4..127: 0-3 are y-protocols types, and a single-byte varint lets the
 * server discriminate with a raw `buf[0]` peek. If a future y-partyserver version ever claims
 * this type, our per-instance provider handler silently shadows it — review on version bumps.
 */
export const MSG_LOCK = 76;

/** Per frame AND per connection — full-replace semantics make them the same bound. */
export const LOCK_MAX_IDS = 4096;
/** ULIDs are 26 chars; bounded headroom, semantics never validated. */
export const LOCK_MAX_ID_LEN = 40;
/** 4096 × (1 len byte + 26 UTF-8) + header ≈ 111KB. */
export const LOCK_MAX_FRAME_BYTES = 131072;
/** Client re-announce cadence while holding ≥1 lock. */
export const LOCK_LEASE_MS = 15_000;
/** Server-side expiry = 3 missed leases. */
export const LOCK_STALE_MS = 45_000;

/** Client egress. Clamps at LOCK_MAX_IDS so an oversized honest set degrades instead of being rejected wholesale. */
export function encodeLockSet(ids: ReadonlySet<string>): Uint8Array<ArrayBuffer> {
  const count = Math.min(ids.size, LOCK_MAX_IDS);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_LOCK);
  encoding.writeVarUint(encoder, count);
  let written = 0;
  for (const id of ids) {
    if (written === count) break;
    encoding.writeVarString(encoder, id);
    written++;
  }
  // toUint8Array allocates a fresh ArrayBuffer-backed view; lib0 just types it loosely.
  return encoding.toUint8Array(encoder) as Uint8Array<ArrayBuffer>;
}

/**
 * Server ingress — THE network-boundary validator. Returns null (ignore whole frame, never
 * partially apply) on: oversize frame, count over cap (checked before any allocation), any id
 * over LOCK_MAX_ID_LEN, trailing bytes, or any decode throw. Expects the full frame including
 * the leading MSG_LOCK varuint.
 */
export function decodeLockSetBody(u8: Uint8Array): string[] | null {
  if (u8.byteLength > LOCK_MAX_FRAME_BYTES) return null;
  try {
    const decoder = decoding.createDecoder(u8);
    decoding.readVarUint(decoder); // MSG_LOCK, already peeked by the caller
    const count = decoding.readVarUint(decoder);
    if (count > LOCK_MAX_IDS) return null;
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = decoding.readVarString(decoder);
      if (id.length > LOCK_MAX_ID_LEN) return null;
      ids.push(id);
    }
    if (decoding.hasContent(decoder)) return null;
    return ids;
  } catch {
    return null;
  }
}

/** Server egress. */
export function encodeLockPeerSet(ownerKey: number, ids: ReadonlySet<string>): Uint8Array<ArrayBuffer> {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_LOCK);
  encoding.writeVarUint(encoder, ownerKey);
  encoding.writeVarUint(encoder, ids.size);
  for (const id of ids) encoding.writeVarString(encoder, id);
  return encoding.toUint8Array(encoder) as Uint8Array<ArrayBuffer>;
}

/**
 * Client ingress — trusted (our own server), no caps. Takes the mid-stream Decoder the provider
 * message handler receives (the MSG_LOCK varuint is already consumed by readMessage's dispatch).
 */
export function decodeLockPeerSetBody(decoder: decoding.Decoder): [ownerKey: number, ids: string[]] {
  const ownerKey = decoding.readVarUint(decoder);
  const count = decoding.readVarUint(decoder);
  const ids: string[] = new Array(count);
  for (let i = 0; i < count; i++) ids[i] = decoding.readVarString(decoder);
  return [ownerKey, ids];
}
