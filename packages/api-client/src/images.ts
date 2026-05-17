import { hc } from 'hono/client';
// Import from app-type, NOT from index — see workers/images/src/app-type.ts for
// why. The real index.ts pulls ambient Env/R2Bucket/HTMLRewriter that would
// leak into client compilation; app-type.ts is the public, ambient-free surface.
import type { ImagesApp } from '../../../workers/images/src/app-type';
import { IMAGES_ORIGIN } from './origins';

export const imagesClient = hc<ImagesApp>(IMAGES_ORIGIN);
export type { ImagesApp };
