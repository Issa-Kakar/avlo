// TEMPORARY STUB - Will be replaced in Phase B
export interface RoomHandles {
  roomId: string;
  readOnly: boolean;
  roomStats?: { bytes: number; cap: number; softWarn: boolean };
  destroy: () => void;
}

export function useRoom(_roomId: string | undefined): RoomHandles | null {
  console.warn('useRoom is stubbed - Phase A cleanup');
  return null;
}
