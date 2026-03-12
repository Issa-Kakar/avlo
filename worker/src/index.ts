import { routePartykitRequest } from 'partyserver';
import type { R2Bucket } from '@cloudflare/workers-types';

export interface Env extends Cloudflare.Env {
  rooms: DurableObjectNamespace;
  DOCS: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const res = await routePartykitRequest(request, env);
    if (res) return res;
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// MUST match [[durable_objects]].class_name in wrangler.toml
export { RoomDurableObject } from './parties/room';
