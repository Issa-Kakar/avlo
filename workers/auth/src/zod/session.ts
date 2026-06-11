import { asUserId, USER_ID_RE } from '@avlo/shared';
import { z } from 'zod/v4';

/**
 * The KV session record at `sess:<sha256hex(token)>`. Parsed on EVERY read
 * (`readSession`), so a corrupt or legacy record degrades to a KV miss (→ anon fallback),
 * never a half-trusted identity. `userId` is format-gated then branded — the `AnonToken`
 * discipline. Profile fields are a sign-in-time snapshot (refreshed on next sign-in; the
 * D1 row IS refreshed each sign-in). Times are epoch-ms; `exp` is authoritative app-side,
 * KV `expirationTtl` is the storage backstop.
 */
export const SessionRecord = z.object({
  v: z.literal(1),
  userId: z.string().regex(USER_ID_RE).transform(asUserId),
  googleSub: z.string().min(1),
  email: z.string(),
  name: z.string(),
  avatarHash: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
  iat: z.number(),
  exp: z.number(),
});
export type SessionRecordT = z.infer<typeof SessionRecord>;
