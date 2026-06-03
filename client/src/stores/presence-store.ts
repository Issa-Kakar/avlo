/**
 * Presence Store — identity-only state for React components.
 *
 * Cursor positions never enter this store. They live in the SoA typed-array
 * tables inside `PresenceCursorRenderer` and project to DOM `<img>` elements
 * each rAF tick — Zustand overhead would be wasted on a non-React render path.
 */

import { create } from 'zustand';
import { getUserId } from './auth-store';

export interface PeerIdentity {
  name: string;
  color: string;
}

interface PresenceState {
  peerIdentities: Map<string, PeerIdentity>;
  peerCount: number;
}

interface PresenceActions {
  setPeers(peers: Map<string, PeerIdentity>): void;
}

export const usePresenceStore = create<PresenceState & PresenceActions>((set) => ({
  peerIdentities: new Map(),
  peerCount: 0,

  setPeers(peers: Map<string, PeerIdentity>) {
    const localId = getUserId();
    const filtered = new Map<string, PeerIdentity>();
    for (const [userId, identity] of peers) {
      if (userId !== localId) filtered.set(userId, identity);
    }
    set({
      peerIdentities: filtered,
      peerCount: filtered.size,
    });
  },
}));
