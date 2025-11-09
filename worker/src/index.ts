import { routePartykitRequest } from "partyserver";
import type { R2Bucket } from "@cloudflare/workers-types";

// Keep Env precise — no index signature
export interface Env {
  rooms: DurableObjectNamespace;
  DOCS: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // partyserver type expects a looser env; cast *only* at the callsite
    const res = await routePartykitRequest(request, env as unknown as Record<string, unknown>);
    if (res) return res;
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// MUST match [[durable_objects]].class_name in wrangler.toml
export { RoomDurableObject } from "./parties/room";