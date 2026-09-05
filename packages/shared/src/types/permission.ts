/**
 * Room permission — the single enum on the room DO's authoritative meta (§8).
 * Shared client + server from one source: the client renders a lock badge
 * (display-only), the room DO enforces it live on every message (§7/§8).
 *
 * Deliberately a plain literal tuple + union, NOT a z.enum — @avlo/shared is
 * client-bundled (`room-doc-manager` narrows the `perm:` push via
 * `isPermission`), and a zod value here drags zod into the web bundle. Server
 * validators derive their schema as `z.enum(PERMISSIONS)`.
 */
export const PERMISSIONS = ['public', 'readonly', 'private'] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Validate + narrow untrusted wire input (the `isZKey` analog). */
export function isPermission(raw: string): raw is Permission {
  return (PERMISSIONS as readonly string[]).includes(raw);
}
