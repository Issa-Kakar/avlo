// Immutable snapshot of room state at a point in time
export interface RoomSnapshot {
  readonly epoch: number;
  readonly roomId: string;
  readonly connectionState: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  readonly isReadOnly: boolean;
  readonly roomStats?: {
    bytes: number;
    cap: number;
    softWarn: boolean;
  };
  readonly presence: ReadonlyMap<string, UserPresence>;
  readonly localUser?: UserPresence;
}

export interface UserPresence {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly cursor: { x: number; y: number } | null;
  readonly activity: 'idle' | 'drawing' | 'typing';
}

// Write operations that go through the queue
export interface WriteOperation {
  id: string;
  type: 'stroke' | 'text' | 'clear' | 'extend' | 'test';
  execute: (ydoc: any) => void;
  origin?: string;
}
