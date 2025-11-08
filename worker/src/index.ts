/// <reference types="@cloudflare/workers-types" />

import { routePartykitRequest } from "partyserver";

/**
 * Environment bindings for this worker
 */
export interface Env {
  // Required: Durable Object namespace binding
  rooms: DurableObjectNamespace;
  // Allow additional properties for PartyKit compatibility
  [key: string]: unknown;
}

/**
 * Main Cloudflare Worker handler
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext // Prefix with _ to indicate intentionally unused
  ): Promise<Response> {
    // Validate that required bindings are present
    if (!env.rooms) {
      console.error("Missing 'rooms' DurableObject binding in wrangler.toml");
      return new Response("Server configuration error", { status: 500 });
    }

    try {
      // Route WebSocket/PartyKit requests to the appropriate Durable Object
      const response = await routePartykitRequest(request, env);

      // If PartyKit handled the request, return its response
      if (response) {
        return response;
      }

      // Handle non-WebSocket requests
      // In production: Serve static assets from here
      // In development: This shouldn't be reached as Vite handles these
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

// Export the Durable Object class
// MUST match the class_name in wrangler.toml
export { RoomDurableObject } from "./parties/room";