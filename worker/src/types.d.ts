/// <reference types="@cloudflare/workers-types" />

/**
 * Module declaration for the cloudflare:workers virtual module
 * This module only exists at runtime in the Cloudflare Workers environment
 * PartyServer imports DurableObject from this module
 */
declare module "cloudflare:workers" {
  // DurableObject class that PartyServer's Server extends
  export class DurableObject {
    constructor(ctx: DurableObjectState, env: any);

    // Optional handler methods
    fetch?(request: Request): Response | Promise<Response>;
    alarm?(): void | Promise<void>;
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
    webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
  }
}