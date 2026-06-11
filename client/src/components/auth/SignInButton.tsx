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

async function signOut() {
  try {
    await authClient.logout.$post();
  } catch (err) {
    console.warn('[auth] logout request failed:', err);
  }
  // Reload through the marker boot path — /me is the identity truth either way.
  window.location.assign(`${window.location.pathname}?auth=out`);
}

/**
 * Placeholder sign-in/out affordance (real account UI is a later phase). Anon → the
 * Google CTA; signed-in → name (email on hover) + Sign out. Reads the synchronous
 * auth-store mirror, so it flips the moment the marker boot's `/me` resolves.
 */
export function SignInButton({ variant }: { variant: 'dashboard' | 'canvas' }) {
  const isAnon = useAuthStore((s) => s.isAnon);
  const name = useAuthStore((s) => s.name);
  const email = useAuthStore((s) => s.email);

  const canvas = variant === 'canvas';
  const btnClass = canvas ? 'top-bar-auth-btn' : 'dash-auth-btn';

  if (isAnon) {
    return (
      <button
        type="button"
        className={btnClass}
        tabIndex={canvas ? -1 : undefined}
        onMouseDown={canvas ? preventFocus : undefined}
        onClick={signIn}
      >
        Sign in with Google
      </button>
    );
  }
  return (
    <div className={canvas ? 'top-bar-auth' : 'dash-auth'} title={email}>
      <span className={canvas ? 'top-bar-auth-name' : 'dash-auth-name'}>{name}</span>
      <button
        type="button"
        className={btnClass}
        tabIndex={canvas ? -1 : undefined}
        onMouseDown={canvas ? preventFocus : undefined}
        onClick={signOut}
      >
        Sign out
      </button>
    </div>
  );
}
