import { RoomDocManager } from '../../../collaboration/RoomDocManager.js';
import { nanoid } from 'nanoid';

const ONE_DAY = 24 * 60 * 60 * 1000;
const EXTEND_KEY = 'avlo:lastExtendAt'; // device-local throttle

export function canExtendNow(): boolean {
  const last = Number(localStorage.getItem(EXTEND_KEY) || '0');
  return Date.now() - last >= ONE_DAY;
}

export function markExtendedNow() {
  localStorage.setItem(EXTEND_KEY, String(Date.now()));
}

/**
 * Performs a minimal write to extend TTL through the WriteQueue
 * This change is excluded from global Undo history by using a different origin
 */
export function extendTtl(roomId: string) {
  if (!canExtendNow()) {
    console.log('TTL extension throttled - can only extend once per 24h');
    return false;
  }

  const manager = RoomDocManager.getInstance(roomId);

  manager.enqueueWrite({
    id: nanoid(),
    type: 'extend',
    execute: (ydoc) => {
      const meta = ydoc.getMap('meta');
      meta.set('keepAliveCounter', (meta.get('keepAliveCounter') || 0) + 1);
      meta.set('lastExtended', new Date().toISOString());
    },
    origin: 'ttl-extend', // Different origin to exclude from undo
  });

  markExtendedNow();
  return true;
}
