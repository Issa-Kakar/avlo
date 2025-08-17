// Keep the type definition
export type ConnectionState = 'Online' | 'Reconnecting' | 'Offline' | 'Read-only';

// GUTTED IN PHASE A - All provider coupling removed
// Will be rebuilt in Phase B to derive from snapshot instead
export function useConnectionState(_provider?: any, readOnly = false): ConnectionState {
  // Temporary stub - always return 'Reconnecting' during Phase A
  if (readOnly) return 'Read-only';
  return 'Reconnecting';
}
