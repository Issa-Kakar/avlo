import { createCors, unfurlQuery } from '@avlo/worker-shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { UnfurlApp as PublicSurface } from './app-type';
import { handleUnfurl } from './unfurl';

const app = new Hono<{ Bindings: Env }>()
  .use('*', createCors('unfurl'))
  .get('/', zValidator('query', unfurlQuery), (c) => handleUnfurl(c, c.req.valid('query').url));

// Drift guard — see workers/images/src/index.ts for rationale.
type _Surface<T> = T extends Hono<infer _E, infer S, infer _BP> ? { [P in keyof S]: keyof S[P] } : never;
type _AssertEq<A, B> = [A, B] extends [B, A] ? true : never;
const _surfaceDrift: _AssertEq<_Surface<typeof app>, _Surface<PublicSurface>> = true;
void _surfaceDrift;

export default app;
export type { UnfurlApp } from './app-type';
