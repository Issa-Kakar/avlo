import { createFileRoute } from '@tanstack/react-router';
import { Dashboard } from '@/components/dashboard';

// The canvas-list dashboard. No beforeLoad — unlike the room route it never
// calls connectRoom (it mounts no canvas). `/` redirects here (routes/index.tsx).
export const Route = createFileRoute('/home')({
  component: Dashboard,
});
