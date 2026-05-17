import { assertSurfaceMatch, createCors } from '@avlo/worker-shared';
import { Hono } from 'hono';
import type { ImagesApp as PublicSurface } from './app-type';
import { handleGetAsset } from './get';
import { handleUpload } from './upload';

const app = new Hono<{ Bindings: Env }>()
  .use('*', createCors('images'))
  .put('/:key', ...handleUpload)
  .get('/:key', ...handleGetAsset);

// Drift guard — keeps the real app's path × method surface aligned with the
// public mock in ./app-type. See @avlo/worker-shared/surface-drift.
assertSurfaceMatch<typeof app, PublicSurface>(true);

export default app;
export type { ImagesApp } from './app-type';
