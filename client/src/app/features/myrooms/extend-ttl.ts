import * as Y from 'yjs';

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
 * Perform a tiny Yjs write to extend TTL. This change should be excluded from global Undo history.
 * Convention: meta.keepAliveCounter++ (or update a meta.lastExtended timestamp).
 * 
 * ⚠️ REQUIRES PHASE 3: meta schema must be defined first
 */
export function extendTtl(ydoc: Y.Doc) {
  // tiny mutation - IMPLEMENT AFTER PHASE 3 SCHEMA IS DEFINED
  const meta = ydoc.getMap('meta');
  const prev = (meta.get('keepAliveCounter') as number) || 0;
  meta.set('keepAliveCounter', prev + 1);
}