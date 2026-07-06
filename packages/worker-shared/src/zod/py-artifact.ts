import { z } from 'zod/v4';

// py-build artifact params: keys are `<buildHash>/<file>` where buildHash is 16
// lowercase hex (truncated sha256 of the canonical build-lock table) — deliberately
// NOT the 64-hex `assetKeyParam`. `file`/`name` bar `/` so a param can never
// traverse into another hash prefix; bundles ride a dedicated 3-segment route.
export const pyArtifactParam = z.object({
  hash: z.string().regex(/^[0-9a-f]{16}$/, 'invalid hash'),
  file: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'invalid file'),
});

export const pyBundleParam = z.object({
  hash: z.string().regex(/^[0-9a-f]{16}$/, 'invalid hash'),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}\.tar$/, 'invalid bundle'),
});
