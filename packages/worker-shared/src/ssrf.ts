// SSRF guard — refuses private / link-local / loopback hostnames before fetch.
// Used in Zod `.refine` clauses on any URL the user can supply.

export function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  if (lower === 'localhost' || lower === '[::1]' || lower.endsWith('.local') || lower.endsWith('.internal')) {
    return true;
  }

  const parts = lower.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const [a, b] = [parseInt(parts[0], 10), parseInt(parts[1], 10)];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }

  return false;
}
