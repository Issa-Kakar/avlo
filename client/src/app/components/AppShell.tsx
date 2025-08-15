import { ReactNode } from 'react';
import { AppHeader } from './AppHeader.js';
import { ConnectionState } from './ConnectionChip.js';

interface AppShellProps {
  children: ReactNode;
  connectionState?: ConnectionState;
  users?: Array<{
    id: string;
    name: string;
    color: string;
    initials: string;
    activity?: 'idle' | 'drawing' | 'typing';
  }>;
  roomTitle?: string;
}

export function AppShell({ children, connectionState, users, roomTitle }: AppShellProps) {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <AppHeader connectionState={connectionState} users={users} roomTitle={roomTitle} />
      <div style={{ flex: 1, overflow: 'hidden' }}>{children}</div>
    </div>
  );
}
