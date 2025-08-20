import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSnapshot } from '../use-snapshot';
import { RoomDocManagerRegistry } from '../../lib/room-doc-manager';
import type { Snapshot } from '@avlo/shared';

describe('useSnapshot', () => {
  afterEach(() => {
    RoomDocManagerRegistry.destroyAll();
  });

  it('should return current snapshot', () => {
    const { result } = renderHook(() => useSnapshot('test-room'));

    const snapshot = result.current;
    expect(snapshot).toBeDefined();
    expect(snapshot.svKey).toBe('empty');
    expect(snapshot.scene).toBe(0);
    expect(snapshot.strokes).toHaveLength(0);
    expect(snapshot.texts).toHaveLength(0);
  });

  it('should update when snapshot changes', async () => {
    const roomId = 'update-test';
    const manager = RoomDocManagerRegistry.get(roomId);

    const { result } = renderHook(() => useSnapshot(roomId));

    const initialSnapshot = result.current;
    expect(initialSnapshot.svKey).toBe('empty');

    // Simulate a snapshot update
    const newSnapshot: Snapshot = {
      ...initialSnapshot,
      svKey: 'updated',
      createdAt: Date.now(),
    };

    // Mock the subscription to trigger update
    const subscribers = new Set<(snap: Snapshot) => void>();
    vi.spyOn(manager, 'subscribeSnapshot').mockImplementation((cb) => {
      subscribers.add(cb);
      cb(manager.currentSnapshot);
      return () => subscribers.delete(cb);
    });

    // Trigger update to all subscribers
    act(() => {
      subscribers.forEach((cb) => cb(newSnapshot));
    });

    await waitFor(() => {
      expect(result.current.svKey).toBe('updated');
    });
  });

  it('should cleanup subscription on unmount', () => {
    const roomId = 'cleanup-test';
    const manager = RoomDocManagerRegistry.get(roomId);

    const unsubMock = vi.fn();
    vi.spyOn(manager, 'subscribeSnapshot').mockReturnValue(unsubMock);

    const { unmount } = renderHook(() => useSnapshot(roomId));

    unmount();

    expect(unsubMock).toHaveBeenCalled();
  });

  it('should handle manager changes', () => {
    const { result, rerender } = renderHook(({ roomId }) => useSnapshot(roomId), {
      initialProps: { roomId: 'room-1' },
    });

    const firstSnapshot = result.current;

    rerender({ roomId: 'room-2' });

    const secondSnapshot = result.current;

    // Different rooms should have different snapshots (both empty initially)
    expect(firstSnapshot).not.toBe(secondSnapshot);
  });

  it('should immediately receive current snapshot on subscription', () => {
    const roomId = 'immediate-test';
    const manager = RoomDocManagerRegistry.get(roomId);

    let immediateCallCount = 0;
    vi.spyOn(manager, 'subscribeSnapshot').mockImplementation((cb) => {
      immediateCallCount++;
      cb(manager.currentSnapshot);
      return () => {};
    });

    renderHook(() => useSnapshot(roomId));

    expect(immediateCallCount).toBeGreaterThan(0);
  });

  it('should handle rapid re-renders', () => {
    const { result, rerender } = renderHook(() => useSnapshot('rapid-test'));

    const snapshot = result.current;

    // Rapid re-renders
    for (let i = 0; i < 10; i++) {
      rerender();
    }

    // Should still have valid snapshot
    expect(result.current).toBeDefined();
    expect(result.current).toBe(snapshot); // Same snapshot if no updates
  });
});
