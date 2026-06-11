import { z } from 'zod/v4';

// Lowercase hex, exactly 32 chars — the truncated SHA-256 that suffixes the `avatars/`
// R2 key (content-addressed, write-once). Canonical lowercase like `asset-key.ts`.
export const avatarHashParam = z.object({
  hash: z.string().regex(/^[0-9a-f]{32}$/, 'invalid hash'),
});
