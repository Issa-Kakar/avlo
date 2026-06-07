import { asUserId, USER_ID_RE } from '@avlo/shared';
import { z } from 'zod/v4';

/**
 * Post-HMAC anon-token payload — the single source for both `/me` issuance and
 * `verifyAnonToken` (cookies.ts). `userId` is format-gated by `USER_ID_RE` then branded,
 * so a truncated/legacy cookie rejects cleanly (→ re-mint) rather than feeding a half-id
 * downstream (§14a). `mintAnonToken` ties its output to `z.input<typeof AnonToken>`, so the
 * minted shape and the verified shape cannot drift.
 */
export const AnonToken = z.object({
  userId: z.string().regex(USER_ID_RE).transform(asUserId),
  iat: z.number(),
  nonce: z.string(),
});
