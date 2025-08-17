// GUTTED IN PHASE A - Direct Y.Doc imports removed
// Will be adapted to use WriteQueue in Phase C

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
 * TODO: Adapt to WriteQueue in Phase C
 * Will perform a tiny write to extend TTL through the queue
 * This change should be excluded from global Undo history
 */
export function extendTtl(_ydoc: any) {
  // Stubbed for Phase A - will be implemented with WriteQueue in Phase C
  console.warn('extendTtl is stubbed in Phase A');
}
