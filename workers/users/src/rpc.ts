import type { UserId } from '@avlo/shared';
import { WorkerEntrypoint } from 'cloudflare:workers';

// Binary RPC surface called only by the auth worker during OAuth sign-in
// (promote-or-adopt the anon id into a durable account row, §9). No public
// endpoint — honors "no public endpoint for anything the client doesn't need."
// OAuth is deferred; the signature + D1 shape are reserved.
export class UsersRpc extends WorkerEntrypoint<Env> {
  async linkAccount(
    _currentUserId: UserId,
    _googleSub: string,
    _profile: { email: string; name: string; picture?: string },
  ): Promise<{ userId: UserId; bookmark: string }> {
    throw new Error('oauth deferred');
  }
}
