/**
 * Auth store — server-resolved identity for the whole app.
 *
 * Identity comes ONLY from the auth worker's `/me` (the server-signed `avlo_anon`
 * cookie today; an account session after OAuth). There is no client-side mint: a cold
 * visitor awaits `/me` via `ensureIdentity()` in the route beforeLoad before any
 * identity read; a returning visitor rehydrates synchronously from localStorage. The
 * persisted store — not a fabricated id — is what preserves offline-first. `getUserId()`
 * / `getUserProfile()` are the single identity source, relocated here from
 * `device-ui-store` so `/me` propagates everywhere (presence, `ownerId` attribution,
 * undo origin).
 *
 * The getters THROW when identity is unresolved (`userId === ''`) — the same fail-fast
 * contract as `getActiveRoom()`. An absent identity is a loud bug, never a silently
 * fabricated id that would mis-attribute everything minted in the gap.
 */
import type { UserId } from '@avlo/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface AuthState {
  userId: UserId;
  isAnon: boolean;
  name: string;
  color: string;
}

// persist over synchronous localStorage rehydrates during create(), so a returning
// user's identity is present at import — before any consumer reads the getters.
// `userId === ''` IS the unresolved gate; there is no optimistic state to distinguish.
// The `'' as UserId` sentinel is the one place a non-minted id exists — the throwing
// getters below ensure it never escapes as a real `UserId` to a consumer.
export const useAuthStore = create<AuthState>()(
  persist((): AuthState => ({ userId: '' as UserId, isAnon: true, name: '', color: '' }), {
    name: 'avlo.auth.v1',
    storage: createJSONStorage(() => localStorage),
  }),
);

/**
 * Imperative getter — the stable user id (anon or account). Throws when identity is
 * unresolved; `await ensureIdentity()` in the route beforeLoad/loader must precede any
 * code path that reads it.
 */
export function getUserId(): UserId {
  const id = useAuthStore.getState().userId;
  if (!id) {
    throw new Error(
      'getUserId(): identity unresolved — await ensureIdentity() in the route beforeLoad/loader before any identity read',
    );
  }
  return id;
}

/** Imperative getter — the full profile for presence + attribution. Throws when unresolved. */
export function getUserProfile(): { userId: UserId; name: string; color: string } {
  const s = useAuthStore.getState();
  if (!s.userId) {
    throw new Error('getUserProfile(): identity unresolved — await ensureIdentity() first');
  }
  return { userId: s.userId, name: s.name, color: s.color };
}
