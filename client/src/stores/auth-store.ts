/**
 * Auth store — server-resolved identity for the whole app.
 *
 * Identity comes ONLY from the auth worker's `/me` (the signed `avlo_anon` cookie today;
 * an account session after OAuth). There is no client-side mint. TanStack Query owns the
 * FETCH + revalidation cadence (`query/me.ts`); this store is the SYNCHRONOUS read mirror
 * the rest of the app depends on. `getUserId()` / `getUserProfile()` resolve at import for
 * a returning visitor (persisted localStorage) — before any React render or the room
 * route's `connectRoom`, neither of which can await. The me query's `queryFn` is the sole
 * writer, via `setIdentity`.
 *
 * Two persistence layers, by design: this store (localStorage, synchronous) is what makes
 * identity available at import; the me query's IndexedDB cache (async) carries the
 * `dataUpdatedAt` that throttles the background cookie-slide. They never diverge — the
 * queryFn writes both (its return value = the query data; its side effect = this store).
 *
 * The getters THROW when identity is unresolved (`userId === ''`) — the same fail-fast
 * contract as `getActiveRoom()`. An absent identity is a loud bug, never a silently
 * fabricated id that would mis-attribute everything minted in the gap.
 */
import type { UserId } from '@avlo/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

/** Resolved identity — structurally the `/me` response (`query/me.ts`). */
export interface Identity {
  userId: UserId;
  isAnon: boolean;
  name: string;
  color: string;
}

interface AuthActions {
  /** Commit a resolved `/me` identity. The me query's `queryFn` is the only caller. */
  setIdentity(identity: Identity): void;
}

export type AuthStore = Identity & AuthActions;

// persist over synchronous localStorage rehydrates during create(), so a returning user's
// identity is present at import — before any consumer reads the getters. `userId === ''` IS
// the unresolved gate; there is no optimistic state to distinguish. The `'' as UserId`
// sentinel is the one place a non-minted id exists — the throwing getters below ensure it
// never escapes as a real `UserId` to a consumer.
export const useAuthStore = create<AuthStore>()(
  persist(
    immer((set) => ({
      userId: '' as UserId,
      isAnon: true,
      name: '',
      color: '',
      setIdentity: (identity) =>
        set((s) => {
          s.userId = identity.userId;
          s.isAnon = identity.isAnon;
          s.name = identity.name;
          s.color = identity.color;
        }),
    })),
    {
      name: 'avlo.auth.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ userId: s.userId, isAnon: s.isAnon, name: s.name, color: s.color }),
    },
  ),
);

/**
 * Imperative getter — the stable user id (anon or account). Throws when identity is
 * unresolved; `await ensureIdentity()` in the route beforeLoad/loader must precede any
 * code path that reads it.
 */
export function getUserId(): UserId {
  const id = useAuthStore.getState().userId;
  if (!id) {
    throw new Error('getUserId(): identity unresolved — await ensureIdentity() in the route beforeLoad/loader before any identity read');
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
