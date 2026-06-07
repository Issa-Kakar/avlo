import { createFileRoute } from '@tanstack/react-router';
import { Dashboard } from '@/components/dashboard';
import { ensureIdentity } from '@/query/me';
import { roomsQueryOptions } from '@/query/rooms';

// No beforeLoad — kept side-effect-free so the top-bar logo can intent-preload /home
// (preloading runs beforeLoad; connectRoom must never fire on hover). Side effects live
// in the loader: resolve identity (the cookie /rooms needs; instant for a returning or
// offline visitor) then warm the rooms projection. The fetch is fired NON-blocking — the
// dashboard renders immediately from local facts and streams server rooms in via
// useQuery, so an offline /rooms failure never errors the route.
export const Route = createFileRoute('/home')({
  loader: async ({ context }) => {
    await ensureIdentity();
    void context.queryClient.prefetchQuery(roomsQueryOptions());
  },
  component: Dashboard,
});
