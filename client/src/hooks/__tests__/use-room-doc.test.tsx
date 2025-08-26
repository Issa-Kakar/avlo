import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { useRoomDoc } from '../use-room-doc';
import { RoomDocRegistryProvider } from '../../lib/room-doc-registry-context';
import { createRoomDocManagerRegistry } from '../../lib/room-doc-manager';

describe('useRoomDoc', () => {
  let registry: ReturnType<typeof createRoomDocManagerRegistry>;

  beforeEach(() => {
    registry = createRoomDocManagerRegistry();
    registry.setDefaultOptions({
      skipProviders: true,
      enablePresenceThrottling: false,
    });
  });

  afterEach(() => {
    registry.destroyAll();
  });

  function wrapper({ children }: { children: React.ReactNode }) {
    return <RoomDocRegistryProvider registry={registry}>{children}</RoomDocRegistryProvider>;
  }

  it('acquires reference on mount and releases on unmount', () => {
    const roomId = 'test-room-001';

    // Spy on registry methods
    const acquireSpy = vi.spyOn(registry, 'acquire');
    const releaseSpy = vi.spyOn(registry, 'release');

    // Mount the hook
    const { unmount } = renderHook(() => useRoomDoc(roomId), { wrapper });

    // Should have acquired a reference
    expect(acquireSpy).toHaveBeenCalledWith(roomId);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(registry.getRefCount(roomId)).toBe(1);

    // Unmount the hook
    unmount();

    // Should have released the reference
    expect(releaseSpy).toHaveBeenCalledWith(roomId);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(registry.getRefCount(roomId)).toBe(0);
    expect(registry.has(roomId)).toBe(false);
  });

  it('properly handles roomId changes', () => {
    const roomId1 = 'test-room-002';
    const roomId2 = 'test-room-003';

    const acquireSpy = vi.spyOn(registry, 'acquire');
    const releaseSpy = vi.spyOn(registry, 'release');

    // Mount with first room
    const { rerender, unmount } = renderHook(({ roomId }) => useRoomDoc(roomId), {
      wrapper,
      initialProps: { roomId: roomId1 },
    });

    expect(acquireSpy).toHaveBeenCalledWith(roomId1);
    expect(registry.getRefCount(roomId1)).toBe(1);

    // Change to second room
    rerender({ roomId: roomId2 });

    // Should have released first room and acquired second
    expect(releaseSpy).toHaveBeenCalledWith(roomId1);
    expect(acquireSpy).toHaveBeenCalledWith(roomId2);
    expect(registry.getRefCount(roomId1)).toBe(0);
    expect(registry.getRefCount(roomId2)).toBe(1);
    expect(registry.has(roomId1)).toBe(false);
    expect(registry.has(roomId2)).toBe(true);

    // Unmount
    unmount();

    // Should have released second room
    expect(releaseSpy).toHaveBeenCalledWith(roomId2);
    expect(registry.getRefCount(roomId2)).toBe(0);
    expect(registry.has(roomId2)).toBe(false);
  });

  it('returns the same manager instance for same roomId', () => {
    const roomId = 'test-room-004';

    // Mount two hooks with same roomId
    const { result: result1 } = renderHook(() => useRoomDoc(roomId), { wrapper });

    const { result: result2 } = renderHook(() => useRoomDoc(roomId), { wrapper });

    // Should return the same manager instance
    expect(result1.current).toBe(result2.current);

    // Should have ref count of 2
    expect(registry.getRefCount(roomId)).toBe(2);
  });

  it('prevents memory leak when navigating between multiple rooms', () => {
    const roomIds = ['room-1', 'room-2', 'room-3', 'room-4', 'room-5'];

    // Mount hook with first room
    const { rerender, unmount } = renderHook(({ roomId }) => useRoomDoc(roomId), {
      wrapper,
      initialProps: { roomId: roomIds[0] },
    });

    // Navigate through all rooms
    for (let i = 1; i < roomIds.length; i++) {
      rerender({ roomId: roomIds[i] });

      // Previous room should be cleaned up
      expect(registry.has(roomIds[i - 1])).toBe(false);
      expect(registry.getRefCount(roomIds[i - 1])).toBe(0);

      // Current room should be active
      expect(registry.has(roomIds[i])).toBe(true);
      expect(registry.getRefCount(roomIds[i])).toBe(1);
    }

    // Only the last room should be in registry
    expect(registry.size()).toBe(1);

    // Unmount
    unmount();

    // All rooms should be cleaned up
    expect(registry.size()).toBe(0);
    roomIds.forEach((roomId) => {
      expect(registry.has(roomId)).toBe(false);
      expect(registry.getRefCount(roomId)).toBe(0);
    });
  });
});
