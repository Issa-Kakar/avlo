/// <reference types="@cloudflare/workers-types" />

declare module "cloudflare:workers" {
  // Minimal ambient types for Workerd's virtual module so TypeScript is happy.
  // partyserver.Server extends this class at type level.
  export class DurableObject<Env = unknown> {
    constructor(ctx: DurableObjectState, env: Env);

    fetch?(request: Request): Response | Promise<Response>;
    alarm?(): void | Promise<void>;
    webSocketMessage?(
      ws: WebSocket,
      message: ArrayBuffer | ArrayBufferView | string
    ): void | Promise<void>;
    webSocketClose?(
      ws: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean
    ): void | Promise<void>;
    webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
  }
}
