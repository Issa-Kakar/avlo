/**
 * Room title normalization — the single validity rule for renames, shared by the
 * client (input `maxLength` + pre-submit normalize), the users worker (Zod body
 * transform) and the room DO (`setTitle` authority-boundary guard). Collapsing
 * whitespace also guarantees titles are single-line, so the `title:<t>` custom
 * WS message stays a flat prefixed string like `mode:`.
 */

export const ROOM_TITLE_MAX_LEN = 60;

/** Collapse whitespace runs + trim. Empty or over-max → null (caller rejects/reverts). */
export function normalizeRoomTitle(raw: string): string | null {
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length === 0 || t.length > ROOM_TITLE_MAX_LEN ? null : t;
}
