import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: () => {
    window.location.href = '/home';
    return null;
  },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
