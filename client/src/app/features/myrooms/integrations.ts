import { upsertVisit } from './store';

/**
 * Call this whenever the user navigates to /rooms/:id.
 * If online, provide server metadata.expires_at and a fresh title to store for display.
 * 
 * ⚠️ INTEGRATION BLOCKED: Requires React Router from Phase 2
 */
export async function recordRoomOpen(params: {
  roomId: string;
  title?: string;
  expires_at?: string; // ISO from GET /api/rooms/:id/metadata
  provisional?: boolean;
}) {
  return upsertVisit(params.roomId, {
    title: params.title,
    expires_at: params.expires_at,
    provisional: params.provisional,
  });
}