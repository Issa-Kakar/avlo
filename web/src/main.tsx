import { RouterProvider } from '@tanstack/react-router';
import ReactDOM from 'react-dom/client';
import { router } from './router';
import './index.css';
import { ensureFontsLoaded } from './core/text/font-loader';
import { resetFontMetrics } from './core/text/text-measure';
import { consumeAuthMarker, purgeLocalRoomDataForSignOut, refreshIdentityForAuthChange } from './query/auth-redirect';
import { queryClient, restoreQueryCache } from './query/client';
import { setPendingRoomsBookmark } from './query/rooms';
// Side-effect: registers the rename + permission mutation defaults BEFORE init() resumes
// hydrated paused mutations (route code-splitting would otherwise register them too late).
import './query/room-rename';
import './query/room-permission';

async function loadFonts() {
  try {
    // CRITICAL: Load fonts before React renders
    // This prevents measuring fallback "cursive" font (ascent 1.1)
    await ensureFontsLoaded();

    // Reset metrics cache so first measurement uses correct font
    resetFontMetrics();
  } catch (error) {
    console.error('[init] Font loading failed:', error);
    // Continue anyway - will use fallback metrics
  }
}

async function init() {
  // First statement: read + strip any `?auth=` OAuth marker (and the adopt-migration `?rbm=`
  // D1 bookmark) before the router can see them.
  const { marker, roomsBookmark } = consumeAuthMarker();

  // The query-cache restore MUST complete before the router mounts: route
  // beforeLoad/loaders fire during mount, and the me query's restored
  // `dataUpdatedAt` is what keeps `/me` a background-only cookie slide
  // (see query/client.ts). Concurrent with fonts; neither ever rejects.
  await Promise.all([restoreQueryCache(), loadFonts()]);

  // Sign-out purges every local room trace (queued mutations, facts, per-room doc DBs)
  // BEFORE the identity refresh — all pre-mount, so no y-indexeddb connection is open.
  if (marker === 'out') await purgeLocalRoomDataForSignOut();

  // Stash the post-adopt D1 bookmark for the first /rooms read (on /home) — read-your-writes,
  // so the dashboard never reads stale pre-migration ownership. After restore, before the
  // identity refresh removes the rooms cache (orthogonal — the stash is a separate module var).
  if (roomsBookmark) setPendingRoomsBookmark(roomsBookmark);

  // Identity changed server-side → force one clean /me. AFTER restore (hydration would
  // resurrect the removed entries), BEFORE mount (the room route's `await ensureIdentity()`
  // + connectRoom must stamp the NEW userId).
  if (marker === 'ok' || marker === 'out') await refreshIdentityForAuthChange();

  // Resume hydrated paused mutations LAST before mount, on EVERY boot path — after the
  // marker branch, so a pre-logout queued mutation can never replay under a new identity.
  // Fire-and-forget: a still-offline mutation pends until reconnect.
  void queryClient.resumePausedMutations();

  ReactDOM.createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
}

init();
