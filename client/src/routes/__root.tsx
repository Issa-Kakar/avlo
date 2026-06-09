import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { queryClient } from '@/query/client';
import { ensureIdentity } from '@/query/me';

// Loaders reach the QueryClient through the router context (not React context), so it
// is typed here and supplied in router.ts.
export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // Warm /me at app boot so the signed cookie + identity resolve as early as possible
  // (deduped with the room route's awaited ensureIdentity and the rooms queryFn).
  // Non-blocking — and a true no-op while the me query is fresh: main.tsx awaits the
  // IDB cache restore BEFORE the router mounts, so the staleTime throttle sees the
  // persisted dataUpdatedAt. Safe under the logo's intent-preload of /home.
  beforeLoad: () => {
    void ensureIdentity();
  },
  component: RootComponent,
});

function RootComponent() {
  // Plain provider — the persisted cache is restored in main.tsx before the router
  // renders (no PersistQueryClientProvider/isRestoring gating needed). Components
  // read the cache via hooks; loaders read the same singleton via router context.
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
}
