import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
  routeTree,
  // Route preloading is OPT-IN PER <Link> (see the top-bar logo's
  // preload="intent"), never global. Intent-preload runs a route's beforeLoad,
  // and /room/$roomId's beforeLoad calls connectRoom() — which destroys the
  // active room's Y.Doc and opens a fresh IndexedDB + WebSocket provider. A
  // router-wide defaultPreload:'intent' would fire that on mere hover; worse,
  // the 30s defaultPreloadStaleTime means the preloaded match is reused on
  // click, so even an `if (!preload)` guard in beforeLoad wouldn't re-run it.
  // Only opt individual <Link>s into preload for routes whose beforeLoad is
  // side-effect-free (today: /home). Revisit only if connectRoom leaves beforeLoad.
  defaultPreload: false,
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
