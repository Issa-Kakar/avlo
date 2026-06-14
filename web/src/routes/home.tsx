import { createFileRoute } from '@tanstack/react-router';
import { Dashboard } from '@/components/dashboard';
import { roomsQueryOptions } from '@/query/rooms';

// No beforeLoad — kept side-effect-free so the top-bar logo can intent-preload /home
// (preloading runs beforeLoad; connectRoom must never fire on hover). The loader is
// fully NON-blocking — the dashboard renders immediately from local facts (even for a
// cold visitor) and streams server rooms in via useQuery, so an offline /rooms failure
// never errors the route. Identity resolves inside the rooms queryFn, which is what
// orders the cookie mint before the /rooms fetch.
export const Route = createFileRoute('/home')({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(roomsQueryOptions());
  },
  component: Dashboard,
});
