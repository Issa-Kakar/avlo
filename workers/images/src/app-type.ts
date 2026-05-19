// Public API surface for `hc<ImagesApp>(...)`. This file's purpose is to encode the
// route shape (paths, methods, validators) in a form the client's typecheck can
// traverse WITHOUT pulling worker ambients (Env, R2Bucket, CacheStorage.default)
// into client compilation. The real handlers live in ./upload, ./get and reach
// ambient runtime types — those files MUST NOT be transitively reachable from
// @avlo/api-client. The drift guard at the bottom of ./index.ts keeps this file
// structurally aligned with the real `typeof app`.
//
// Schemas are inlined (intentionally minimal). The real handlers use the full
// schemas from @avlo/worker-shared for validation + refinement; the mock only
// expresses the wire-level input shape that `hc` needs to type the client call.

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod/v4';

const keyParam = z.object({ key: z.string() });
const contentLengthHeader = z.object({ 'content-length': z.string() });

const app = new Hono()
  .put('/:key', zValidator('param', keyParam), zValidator('header', contentLengthHeader), (c) =>
    c.json({} as { key: string; status: 'created' | 'exists' } | { error: string }),
  )
  .get('/:key', zValidator('param', keyParam), (c) => c.body(null));

export type ImagesApp = typeof app;
