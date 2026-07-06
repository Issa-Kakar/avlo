import type { RoomId, UserId } from '../types/identifiers';
import { asRoomId, ROOM_ID_RE } from '../utils/room-id';
import { asUserId, USER_ID_RE } from '../utils/user-id';

/**
 * AI wire protocol constants + agent addressing — the strings both runtimes
 * must agree on (the `SYNC_WS_PREFIX` discipline, AI edition).
 *
 * Transport is the Agents SDK: the browser's `useAgent` opens
 * `wss://ai.avlo.io/agents/<AI_AGENT_KEBAB>/<name>` where `<name>` is
 * `buildAgentName(userId, roomId)`. The edge gate (workers/ai `src/gate.ts`)
 * verifies the session cookie and asserts the name's userId — a user can only
 * ever reach their OWN agent instances.
 */

/** URL path segment for the agent class (kebab-case of `AvloAiAgent`). */
export const AI_AGENT_KEBAB = 'avlo-ai-agent';

/** Agents SDK routing prefix (fixed by `routeAgentRequest`). */
export const AI_AGENTS_PREFIX = 'agents';

/**
 * Terminal WS close codes — sync's convention (H27). The client treats both
 * as "stop reconnecting": 4401 = not signed in with an account (or session
 * unverifiable), 4403 = name/identity mismatch.
 */
export const AI_CLOSE_UNAUTHENTICATED = 4401;
export const AI_CLOSE_FORBIDDEN = 4403;

/** One agent DO per (user, room): conversation-per-room, identity-per-user. */
export function buildAgentName(userId: UserId, roomId: RoomId): string {
  return `${userId}:${roomId}`;
}

/**
 * Parse + validate an agent instance name. Returns null on ANY malformation —
 * callers treat null as forbidden. ULIDs and room ids are colon-free, so the
 * first `:` is unambiguous.
 */
export function parseAgentName(name: string): { userId: UserId; roomId: RoomId } | null {
  const sep = name.indexOf(':');
  if (sep < 0) return null;
  const user = name.slice(0, sep);
  const room = name.slice(sep + 1);
  if (!USER_ID_RE.test(user) || !ROOM_ID_RE.test(room)) return null;
  return { userId: asUserId(user), roomId: asRoomId(room) };
}

/** UIMessage data-part names (`data-<name>` on the wire). */
export const AI_DATA_PART_CONTEXT = 'canvasContext';
export const AI_DATA_PART_QUOTA = 'quota';

/** Tool names — the model-visible vocabulary. */
export const AI_TOOL_CANVAS = 'canvas';
export const AI_TOOL_CANVAS_READ = 'canvas_read';
export const AI_TOOL_GENERATE_IMAGE = 'generate_image';

/** What one turn charges up-front (see `limits.ts` for the estimate model). */
export interface AiReserveEstimate {
  msgs: number;
  /** Weighted tokens (in×W_IN + out×W_OUT). */
  tokens: number;
  images: number;
}

/** Post-turn actuals reported by the provider. */
export interface AiActualUsage {
  tokensIn: number;
  tokensOut: number;
  images: number;
}

export type AiQuotaReason = 'minute' | 'day-msgs' | 'day-tokens' | 'day-images';

/** Current bucket levels — pushed to the client via agent state after every reserve/settle. */
export interface AiQuotaSnapshot {
  minuteMsgsUsed: number;
  dayMsgsUsed: number;
  dayTokensUsed: number;
  dayImagesUsed: number;
  /** Epoch ms when the day buckets roll (UTC midnight). */
  dayResetAt: number;
}

export type AiQuotaVerdict =
  | { ok: true; snapshot: AiQuotaSnapshot }
  | { ok: false; reason: AiQuotaReason; retryAfterMs: number; snapshot: AiQuotaSnapshot };

/** Agents-SDK synced state (server-writable, client-readable). */
export interface AiAgentState {
  quota: AiQuotaSnapshot | null;
}
