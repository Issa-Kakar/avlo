import type { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { persister, queryClient } from '@/query/client';
import { ensureIdentity } from '@/query/me';

// Loaders reach the QueryClient through the router context (not React context), so it
// is typed here and supplied in router.ts.
export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // Warm /me at app boot so the signed cookie + identity resolve as early as possible
  // (deduped with the room route's awaited ensureIdentity and the dashboard loader).
  // Non-blocking — safe under the logo's intent-preload of /home.
  beforeLoad: () => {
    void ensureIdentity();
  },
  component: RootComponent,
});

function RootComponent() {
  // PersistQueryClientProvider restores the IndexedDB-persisted cache once at boot,
  // then renders. Components read the cache via hooks; loaders read the same singleton
  // via router context.
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, buster: 'v1' }}>
      <Outlet />
    </PersistQueryClientProvider>
  );
}
