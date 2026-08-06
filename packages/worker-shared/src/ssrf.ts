// SSRF guard — refuses private / link-local / loopback hostnames before fetch.
// Used in Zod `.refine` clauses on any URL the user can supply, and re-run on
// EVERY redirect hop by `fetchGuarded` (fetch-bytes.ts) — the refine alone can't
// see where a redirect chain or an attacker-authored og:image URL lands.

function isPrivateIpv4(a: number, b: number, c: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true; // loopback, RFC1918, "this network"
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4 + broadcast
  return false;
}

// `inner` is the bracket-stripped, WHATWG-normalized IPv6 literal: lowercase,
// zero-compressed hex groups (dotted IPv4-mapped INPUT re-serializes to hex,
// e.g. `http://[::ffff:127.0.0.1]/` → hostname `[::ffff:7f00:1]`).
function isPrivateIpv6(inner: string): boolean {
  if (inner === '::' || inner === '::1') return true; // unspecified + loopback
  if (inner.startsWith('fc') || inner.startsWith('fd')) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(inner)) return true; // link-local fe80::/10
  if (inner.startsWith('::ffff:')) {
    // IPv4-mapped — recover the embedded IPv4 and re-run the v4 ranges.
    // Handles both serializations: `::ffff:7f00:1` (hex groups) and a raw
    // hand-built `::ffff:127.0.0.1`. Ambiguous compressed corner forms parse
    // conservatively (over-blocking is fine; only under-blocking is a hole).
    const tail = inner.slice(7);
    let a: number;
    let b: number;
    let c: number;
    if (tail.includes('.')) {
      const p = tail.split('.');
      a = Number(p[0]);
      b = Number(p[1]);
      c = Number(p[2]);
    } else {
      const groups = tail.split(':');
      const hi = parseInt(groups[0] || '0', 16);
      const lo = parseInt(groups[1] || '0', 16);
      a = hi >> 8;
      b = hi & 0xff;
      c = lo >> 8;
    }
    return isPrivateIpv4(a, b, c);
  }
  // Known, deliberate under-blocks: deprecated IPv4-COMPATIBLE addresses (`::7f00:1`,
  // unroutable since RFC 4291 deprecated the form) and NAT64 `64:ff9b::/96` (requires
  // a NAT64 gateway on the egress path, which Cloudflare's fetch does not traverse).
  // Neither is reachable from a worker; add arms here only with evidence.
  return false;
}

export function isPrivateHost(hostname: string): boolean {
  let lower = hostname.toLowerCase();
  // A trailing dot is the same resolution target ('localhost.' === 'localhost')
  // but defeats every equality/suffix check below — strip it first.
  if (lower.endsWith('.')) lower = lower.slice(0, -1);

  if (lower.startsWith('[') && lower.endsWith(']')) return isPrivateIpv6(lower.slice(1, -1));

  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    return true;
  }

  const parts = lower.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    return isPrivateIpv4(parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10));
  }

  return false;
}
