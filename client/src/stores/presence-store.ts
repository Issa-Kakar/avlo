/**
 * Presence Store — identity-only state for React components.
 *
 * Cursor positions never enter this store (they live in the mutable
 * PeerCursorState map in lib/presence.ts, read directly by
 * CursorAnimationJob at render time with zero Zustand overhead).
 */

import { create } from 'zustand';

export interface PeerIdentity {
  name: string;
  color: string;
}

interface PresenceState {
  localUserId: string;
  peerIdentities: Map<string, PeerIdentity>;
  peerCount: number;
  isAlone: boolean;
}

interface PresenceActions {
  setLocalUserId(id: string): void;
  setPeers(peers: Map<string, PeerIdentity>): void;
}

export const usePresenceStore = create<PresenceState & PresenceActions>((set) => ({
  localUserId: '',
  peerIdentities: new Map(),
  peerCount: 0,
  isAlone: true,

  setLocalUserId(id: string) {
    set({ localUserId: id });
  },

  setPeers(peers: Map<string, PeerIdentity>) {
    set((state) => {
      // Filter out local user's own identity (same user, different tab)
      const filtered = new Map<string, PeerIdentity>();
      for (const [userId, identity] of peers) {
        if (userId !== state.localUserId) filtered.set(userId, identity);
      }
      return {
        peerIdentities: filtered,
        peerCount: filtered.size,
        isAlone: filtered.size === 0,
      };
    });
  },
}));
