import { z } from 'zod/v4';

/**
 * Open-redirect defense. `return_to` is attacker-influencable (it rides the public /login
 * URL and round-trips through the browser inside the flow cookie), so it must never become
 * an absolute or protocol-relative URL, a backslash variant (`/\evil.com` — browsers
 * normalize `\` to `/`), or smuggle control bytes. Applied at /login AND re-applied at
 * /callback; every failure degrades to `/home`, never an error.
 */
export function sanitizeReturnTo(raw: string | undefined): string {
  if (!raw || raw.length > 256) return '/home';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/home';
  if (raw.includes('\\')) return '/home';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return '/home'; // control chars (CRLF smuggling et al)
  }
  return raw;
}

/** `GET /login/google` query. */
export const loginQuery = z.object({ return_to: z.string().optional() });

/** `GET /callback` query — all optional; the handler sequences its own presence checks. */
export const callbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

/** Payload of the signed single-use `avlo_oauth` flow cookie (state + PKCE verifier + nonce). */
export const OAuthFlowToken = z.object({
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
  nonce: z.string().min(1),
  returnTo: z.string(),
  iat: z.number(),
});

/**
 * Post-`jwtVerify` claim narrowing. jose already proved signature/issuer/audience/expiry;
 * this pins the SHAPE we consume. `email_verified === true` is hard-required — an
 * unverified address must never key an account. Unknown claims (azp, at_hash, …) strip.
 */
export const GoogleClaims = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.literal(true),
  nonce: z.string().min(1),
  name: z.string().optional(),
  picture: z.url().optional(),
});
export type GoogleClaimsT = z.infer<typeof GoogleClaims>;
