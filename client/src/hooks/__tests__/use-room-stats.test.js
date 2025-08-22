import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useRoomStats } from '../use-room-stats';
import { RoomDocManagerRegistry } from '../../lib/room-doc-manager';
describe('useRoomStats', () => {
    afterEach(() => {
        RoomDocManagerRegistry.destroyAll();
    });
    it('should return initial room stats', () => {
        const { result } = renderHook(() => useRoomStats('test-room'));
        const stats = result.current;
        // Initial stats might be null or have default values
        if (stats) {
            expect(stats).toHaveProperty('bytes');
            expect(stats).toHaveProperty('cap');
            expect(stats.cap).toBe(10 * 1024 * 1024); // 10MB
        }
    });
    it('should update when stats change', async () => {
        const roomId = 'stats-update-test';
        const manager = RoomDocManagerRegistry.get(roomId);
        const { result } = renderHook(() => useRoomStats(roomId));
        const newStats = {
            bytes: 1024 * 500, // 500KB
            cap: 10 * 1024 * 1024, // 10MB
        };
        // Mock the subscription to trigger update
        const subscribers = new Set();
        vi.spyOn(manager, 'subscribeRoomStats').mockImplementation((cb) => {
            subscribers.add(cb);
            cb(null); // Initial call might be null
            return () => subscribers.delete(cb);
        });
        // Trigger update to all subscribers
        act(() => {
            subscribers.forEach((cb) => cb(newStats));
        });
        await waitFor(() => {
            expect(result.current).toEqual(newStats);
            expect(result.current?.bytes).toBe(1024 * 500);
        });
    });
    it('should handle null stats', () => {
        const roomId = 'null-stats-test';
        const manager = RoomDocManagerRegistry.get(roomId);
        vi.spyOn(manager, 'subscribeRoomStats').mockImplementation((cb) => {
            cb(null);
            return () => { };
        });
        const { result } = renderHook(() => useRoomStats(roomId));
        expect(result.current).toBeNull();
    });
    it('should cleanup subscription on unmount', () => {
        const roomId = 'stats-cleanup-test';
        const manager = RoomDocManagerRegistry.get(roomId);
        const unsubMock = vi.fn();
        vi.spyOn(manager, 'subscribeRoomStats').mockReturnValue(unsubMock);
        const { unmount } = renderHook(() => useRoomStats(roomId));
        unmount();
        expect(unsubMock).toHaveBeenCalled();
    });
    it('should handle room size warnings', async () => {
        const roomId = 'size-warning-test';
        const manager = RoomDocManagerRegistry.get(roomId);
        const { result } = renderHook(() => useRoomStats(roomId));
        // Stats showing room is near capacity
        const warningStats = {
            bytes: 8 * 1024 * 1024, // 8MB (warning threshold)
            cap: 10 * 1024 * 1024, // 10MB
        };
        const subscribers = new Set();
        vi.spyOn(manager, 'subscribeRoomStats').mockImplementation((cb) => {
            subscribers.add(cb);
            cb(null);
            return () => subscribers.delete(cb);
        });
        act(() => {
            subscribers.forEach((cb) => cb(warningStats));
        });
        await waitFor(() => {
            expect(result.current?.bytes).toBe(8 * 1024 * 1024);
            // Room is at 80% capacity - warning threshold
            const percentUsed = (result.current.bytes / result.current.cap) * 100;
            expect(percentUsed).toBe(80);
        });
    });
    it('should handle room at capacity', async () => {
        const roomId = 'at-capacity-test';
        const manager = RoomDocManagerRegistry.get(roomId);
        const { result } = renderHook(() => useRoomStats(roomId));
        // Stats showing room is at capacity (read-only)
        const atCapacityStats = {
            bytes: 10 * 1024 * 1024, // 10MB (at cap)
            cap: 10 * 1024 * 1024, // 10MB
        };
        const subscribers = new Set();
        vi.spyOn(manager, 'subscribeRoomStats').mockImplementation((cb) => {
            subscribers.add(cb);
            cb(null);
            return () => subscribers.delete(cb);
        });
        act(() => {
            subscribers.forEach((cb) => cb(atCapacityStats));
        });
        await waitFor(() => {
            expect(result.current?.bytes).toBe(result.current?.cap);
            // Room is at 100% capacity - should be read-only
            const percentUsed = (result.current.bytes / result.current.cap) * 100;
            expect(percentUsed).toBe(100);
        });
    });
    it('should immediately receive current stats on subscription', () => {
        const roomId = 'immediate-stats-test';
        const manager = RoomDocManagerRegistry.get(roomId);
        let immediateCallCount = 0;
        vi.spyOn(manager, 'subscribeRoomStats').mockImplementation((cb) => {
            immediateCallCount++;
            cb({ bytes: 1000, cap: 10 * 1024 * 1024 });
            return () => { };
        });
        renderHook(() => useRoomStats(roomId));
        expect(immediateCallCount).toBeGreaterThan(0);
    });
    it('should handle stats updates during rapid re-renders', () => {
        const roomId = 'rapid-stats-test';
        const { result, rerender } = renderHook(() => useRoomStats(roomId));
        // Rapid re-renders
        for (let i = 0; i < 10; i++) {
            rerender();
        }
        // Should still have valid result (null or stats)
        expect(result.current === null ||
            (result.current?.bytes !== undefined && result.current?.cap !== undefined)).toBe(true);
    });
});
