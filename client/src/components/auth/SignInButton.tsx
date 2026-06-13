import { authClient } from '@avlo/api-client';
import type { MouseEvent } from 'react';
import { useAuthStore } from '@/stores/auth-store';

/** Chrome controls stay out of the focus system on the canvas (same pattern as
 *  HistoryButtons/Share); the dashboard variant keeps normal focus behavior. */
const preventFocus = (e: MouseEvent) => e.preventDefault();

function signIn() {
  // Top-level navigation, not fetch — the flow cookie + Google consent need a real nav.
  // hc's `$url()` keeps the `/api/auth` dev-proxy prefix (string-concat mergePath), so
  // the same code serves dev (Vite proxy) and prod (auth.avlo.io).
  const url = authClient.login.google.$url();
  url.searchParams.set('return_to', window.location.pathname);
  window.location.assign(url.toString());
}

/** Sign out, then reload through the `?auth=out` marker boot — ALWAYS onto /home (the
 *  active room may be one the next identity can't access; the dashboard is the only
 *  identity-neutral surface). The boot path purges all local room data + re-resolves
 *  identity before anything renders. Exported for `UserProfileMenu`'s Log out row. */
export async function signOut() {
  try {
    await authClient.logout.$post();
  } catch (err) {
    console.warn('[auth] logout request failed:', err);
  }
  window.location.assign('/home?auth=out');
}

/**
 * Anon-only Google sign-in CTA — renders nothing for a signed-in user (the profile
 * menu, `UserProfileMenu`, is the signed-in affordance). Reads the synchronous
 * auth-store mirror, so it flips the moment the marker boot's `/me` resolves.
 */
export function SignInButton({ variant }: { variant: 'dashboard' | 'canvas' }) {
  const isAnon = useAuthStore((s) => s.isAnon);
  if (!isAnon) return null;

  const canvas = variant === 'canvas';
  return (
    <button
      type="button"
      className={canvas ? 'top-bar-auth-btn' : 'dash-auth-btn'}
      tabIndex={canvas ? -1 : undefined}
      onMouseDown={canvas ? preventFocus : undefined}
      onClick={signIn}
    >
      Sign in with Google
    </button>
  );
}
