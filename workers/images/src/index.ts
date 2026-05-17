import { createCors } from '@avlo/worker-shared';
import { Hono } from 'hono';
import type { ImagesApp as PublicSurface } from './app-type';
import { handleGetAsset } from './get';
import { handleUpload } from './upload';

const app = new Hono<{ Bindings: Env }>()
  .use('*', createCors('images'))
  .put('/:key', ...handleUpload)
  .get('/:key', ...handleGetAsset);

// Drift guard. The real route surface must match the public mock in app-type.ts
// at the path × method level. We don't compare full Hono types — the real app
// has `Bindings: Env`, the mock has empty bindings, and input/output shapes
// differ in approximation depth. What matters for hc<App> safety is: same paths,
// same methods. _Surface extracts `{ [path]: keyof methods }`; _AssertEq fails
// when real and mock diverge in either direction.
type _Surface<T> = T extends Hono<infer _E, infer S, infer _BP> ? { [P in keyof S]: keyof S[P] } : never;
type _AssertEq<A, B> = [A, B] extends [B, A] ? true : never;
const _surfaceDrift: _AssertEq<_Surface<typeof app>, _Surface<PublicSurface>> = true;
void _surfaceDrift;

export default app;
export type { ImagesApp } from './app-type';
