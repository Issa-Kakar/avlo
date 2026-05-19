import { z } from 'zod/v4';

// Lowercase hex, exactly 64 chars (SHA-256). Upper-case rejected — canonical form.
export const assetKeyParam = z.object({
  key: z.string().regex(/^[0-9a-f]{64}$/, 'invalid key'),
});
