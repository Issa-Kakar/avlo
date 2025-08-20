import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePresence } from '../use-presence';
import { RoomDocManagerRegistry } from '../../lib/room-doc-manager';
import type { PresenceView } from '@avlo/shared';

describe('usePresence', () => {
  afterEach(() => {
    RoomDocManagerRegistry.destroyAll();
  });

  it('should return current presence view', () => {
    const { result } = renderHook(() => usePresence('test-room'));

    const presence = result.current;
    expect(presence).toBeDefined();
    expect(presence.users).toBeInstanceOf(Map);
    expect(presence.localUserId).toBeDefined();
  });

  it('should update when presence changes', async () => {
    const roomId = 'presence-update-test';
    const manager = RoomDocManagerRegistry.get(roomId);

    const { result } = renderHook(() => usePresence(roomId));

    const initialPresence = result.current;
    expect(initialPresence.users.size).toBe(0);

    // Create new presence with a user
    const newPresence: PresenceView = {
      users: new Map([
        [
          'user-1',
          {
            name: 'Test User',
            color: '#FF0000',
            cursor: { x: 100, y: 200 },
            activity: 'drawing',
            lastSeen: Date.now(),
          },
        ],
      ]),
      localUserId: 'user-1',
    };

    // Mock the subscription to trigger update
    const subscribers = new Set<(p: PresenceView) => void>();
    vi.spyOn(manager, 'subscribePresence').mockImplementation((cb) => {
      subscribers.add(cb);
      cb(manager.currentSnapshot.presence);
      return () => subscribers.delete(cb);
    });

    // Trigger update to all subscribers
    act(() => {
      subscribers.forEach((cb) => cb(newPresence));
    });

    await waitFor(() => {
      expect(result.current.users.size).toBe(1);
      expect(result.current.localUserId).toBe('user-1');
    });
  });

  it('should cleanup subscription on unmount', () => {
    const roomId = 'presence-cleanup-test';
    const manager = RoomDocManagerRegistry.get(roomId);

    const unsubMock = vi.fn();
    vi.spyOn(manager, 'subscribePresence').mockReturnValue(unsubMock);

    const { unmount } = renderHook(() => usePresence(roomId));

    unmount();

    expect(unsubMock).toHaveBeenCalled();
  });

  it('should handle multiple users in presence', async () => {
    const roomId = 'multi-user-test';
    const manager = RoomDocManagerRegistry.get(roomId);

    const { result } = renderHook(() => usePresence(roomId));

    const multiUserPresence: PresenceView = {
      users: new Map([
        [
          'user-1',
          {
            name: 'User 1',
            color: '#FF0000',
            cursor: { x: 100, y: 100 },
            activity: 'idle',
            lastSeen: Date.now(),
          },
        ],
        [
          'user-2',
          {
            name: 'User 2',
            color: '#00FF00',
            cursor: { x: 200, y: 200 },
            activity: 'drawing',
            lastSeen: Date.now(),
          },
        ],
        [
          'user-3',
          {
            name: 'User 3',
            color: '#0000FF',
            activity: 'typing',
            lastSeen: Date.now(),
          },
        ],
      ]),
      localUserId: 'user-1',
    };

    const subscribers = new Set<(p: PresenceView) => void>();
    vi.spyOn(manager, 'subscribePresence').mockImplementation((cb) => {
      subscribers.add(cb);
      cb(manager.currentSnapshot.presence);
      return () => subscribers.delete(cb);
    });

    act(() => {
      subscribers.forEach((cb) => cb(multiUserPresence));
    });

    await waitFor(() => {
      expect(result.current.users.size).toBe(3);
      expect(result.current.users.get('user-1')?.name).toBe('User 1');
      expect(result.current.users.get('user-2')?.activity).toBe('drawing');
      expect(result.current.users.get('user-3')?.cursor).toBeUndefined();
    });
  });

  it('should immediately receive current presence on subscription', () => {
    const roomId = 'immediate-presence-test';
    const manager = RoomDocManagerRegistry.get(roomId);

    let immediateCallCount = 0;
    vi.spyOn(manager, 'subscribePresence').mockImplementation((cb) => {
      immediateCallCount++;
      cb(manager.currentSnapshot.presence);
      return () => {};
    });

    renderHook(() => usePresence(roomId));

    expect(immediateCallCount).toBeGreaterThan(0);
  });

  it('should handle cursor updates', async () => {
    const roomId = 'cursor-test';
    const manager = RoomDocManagerRegistry.get(roomId);

    const { result } = renderHook(() => usePresence(roomId));

    const presenceWithCursor: PresenceView = {
      users: new Map([
        [
          'user-1',
          {
            name: 'Cursor User',
            color: '#FF0000',
            cursor: { x: 50, y: 75 },
            activity: 'idle',
            lastSeen: Date.now(),
          },
        ],
      ]),
      localUserId: 'user-1',
    };

    const subscribers = new Set<(p: PresenceView) => void>();
    vi.spyOn(manager, 'subscribePresence').mockImplementation((cb) => {
      subscribers.add(cb);
      cb(manager.currentSnapshot.presence);
      return () => subscribers.delete(cb);
    });

    act(() => {
      subscribers.forEach((cb) => cb(presenceWithCursor));
    });

    await waitFor(() => {
      const user = result.current.users.get('user-1');
      expect(user?.cursor).toEqual({ x: 50, y: 75 });
    });

    // Update cursor position
    const updatedPresence: PresenceView = {
      ...presenceWithCursor,
      users: new Map([
        [
          'user-1',
          {
            ...presenceWithCursor.users.get('user-1')!,
            cursor: { x: 150, y: 175 },
          },
        ],
      ]),
    };

    act(() => {
      subscribers.forEach((cb) => cb(updatedPresence));
    });

    await waitFor(() => {
      const user = result.current.users.get('user-1');
      expect(user?.cursor).toEqual({ x: 150, y: 175 });
    });
  });
});
