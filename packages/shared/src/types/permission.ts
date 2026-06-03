import { z } from 'zod/v4';

/**
 * Room permission — the single enum on the room DO's authoritative meta (§8).
 * Shared client + server from one source: the client renders a lock badge
 * (display-only), the room DO enforces it live on every message (§7/§8).
 */
export const Permission = z.enum(['public', 'readonly', 'private']);
export type Permission = z.infer<typeof Permission>;
