import { getHttpBase } from '../../utils/url.js';

export type ParsedTarget =
  | { kind: 'url'; roomId: string }
  | { kind: 'id'; roomId: string }
  | { kind: 'code'; code: string }
  | { kind: 'invalid' };

export function parseJoinInput(raw: string): ParsedTarget {
  const s = raw.trim();

  // Case 1: full URL
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/rooms\/([A-Za-z0-9_-]{1,64})$/);
    if (m) return { kind: 'url', roomId: m[1] };
  } catch {
    // Not a valid URL, continue to other cases
  }

  // Case 2: canonical ULID-ish id (20-32 alphanumeric with optional hyphens/underscores)
  if (/^[A-Za-z0-9_-]{20,32}$/i.test(s)) {
    return { kind: 'id', roomId: s };
  }

  // Case 3: short share code (6 uppercase alphanumeric)
  if (/^[A-Z0-9]{6}$/i.test(s)) {
    return { kind: 'code', code: s.toUpperCase() };
  }

  return { kind: 'invalid' };
}

export async function roomExists(roomId: string): Promise<boolean> {
  // Try metadata endpoint first
  try {
    const response = await fetch(`${getHttpBase()}/api/rooms/${roomId}/metadata`, {
      method: 'GET',
    });

    if (response.ok) return true;

    // Treat 404 or 500 as not found (tolerant of legacy semantics)
    if (response.status === 404 || response.status === 500) {
      return false;
    }

    // For other errors, assume not found
    return false;
  } catch (e) {
    // Network error - assume not found
    console.warn('Failed to check room existence:', e);
    return false;
  }
}

// Generate a short share code from a room ID
export function generateShareCode(roomId: string): string {
  // Simple approach: take last 6 chars of room ID in uppercase
  // In production, you might want to use a proper hash or mapping
  const cleaned = roomId.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  return cleaned.slice(-6).padStart(6, '0');
}

// Resolve a share code to a room ID (would need server support in production)
export async function resolveCode(_code: string): Promise<string | null> {
  // For MVP, we don't have server-side code mapping
  // This would need a server endpoint like GET /api/rooms/resolve/:code
  // For now, return null to indicate code resolution is not supported
  return null;
}
