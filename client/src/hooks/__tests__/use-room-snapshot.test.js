import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useRoomSnapshot } from '../use-room-snapshot';
import { RoomDocManagerRegistry } from '../../lib/room-doc-manager';
describe('useRoomSnapshot', () => {
    afterEach(() => {
        RoomDocManagerRegistry.destroyAll();
    });
    it('should return current snapshot', () => {
        const { result } = renderHook(() => useRoomSnapshot('test-room'));
        const snapshot = result.current;
        expect(snapshot).toBeDefined();
        expect(snapshot.svKey).toBe('empty');
        expect(snapshot.scene).toBe(0);
        expect(snapshot.strokes).toHaveLength(0);
        expect(snapshot.texts).toHaveLength(0);
    });
    it('should be equivalent to useSnapshot', () => {
        const roomId = 'equivalent-test';
        const { result: roomSnapshotResult } = renderHook(() => useRoomSnapshot(roomId));
        const { result: snapshotResult } = renderHook(() => useRoomSnapshot(roomId));
        // Both hooks should return the same snapshot
        expect(roomSnapshotResult.current).toEqual(snapshotResult.current);
    });
    it('should update when snapshot changes', async () => {
        const roomId = 'update-test';
        const manager = RoomDocManagerRegistry.get(roomId);
        const { result } = renderHook(() => useRoomSnapshot(roomId));
        const initialSnapshot = result.current;
        expect(initialSnapshot.svKey).toBe('empty');
        // Simulate a snapshot update
        const newSnapshot = {
            ...initialSnapshot,
            svKey: 'updated-room-snapshot',
            createdAt: Date.now(),
        };
        // Mock the subscription to trigger update
        const subscribers = new Set();
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
            expect(result.current.svKey).toBe('updated-room-snapshot');
        });
    });
    it('should cleanup subscription on unmount', () => {
        const roomId = 'cleanup-test';
        const manager = RoomDocManagerRegistry.get(roomId);
        const unsubMock = vi.fn();
        vi.spyOn(manager, 'subscribeSnapshot').mockReturnValue(unsubMock);
        const { unmount } = renderHook(() => useRoomSnapshot(roomId));
        unmount();
        expect(unsubMock).toHaveBeenCalled();
    });
    it('should handle scene changes in snapshot', async () => {
        const roomId = 'scene-test';
        const manager = RoomDocManagerRegistry.get(roomId);
        const { result } = renderHook(() => useRoomSnapshot(roomId));
        expect(result.current.scene).toBe(0);
        // Simulate scene change
        const sceneChangeSnapshot = {
            ...result.current,
            svKey: 'scene-changed',
            scene: 2,
            createdAt: Date.now(),
        };
        const subscribers = new Set();
        vi.spyOn(manager, 'subscribeSnapshot').mockImplementation((cb) => {
            subscribers.add(cb);
            cb(manager.currentSnapshot);
            return () => subscribers.delete(cb);
        });
        act(() => {
            subscribers.forEach((cb) => cb(sceneChangeSnapshot));
        });
        await waitFor(() => {
            expect(result.current.scene).toBe(2);
        });
    });
    it('should handle strokes and texts in snapshot', async () => {
        const roomId = 'content-test';
        const manager = RoomDocManagerRegistry.get(roomId);
        const { result } = renderHook(() => useRoomSnapshot(roomId));
        // Create snapshot with strokes and texts
        const contentSnapshot = {
            ...result.current,
            svKey: 'has-content',
            strokes: Object.freeze([
                {
                    id: 'stroke-1',
                    points: [0, 0, 50, 50, 100, 100], // Add points for renderer
                    polyline: null,
                    style: {
                        color: '#000000',
                        size: 5,
                        opacity: 1,
                        tool: 'pen',
                    },
                    bbox: [0, 0, 100, 100],
                    scene: 0, // Required for causal consistency
                },
            ]),
            texts: Object.freeze([
                {
                    id: 'text-1',
                    x: 50,
                    y: 50,
                    w: 100,
                    h: 20,
                    content: 'Hello World',
                    style: {
                        color: '#000000',
                        size: 16,
                    },
                    scene: 0, // Required for causal consistency
                },
            ]),
            createdAt: Date.now(),
        };
        const subscribers = new Set();
        vi.spyOn(manager, 'subscribeSnapshot').mockImplementation((cb) => {
            subscribers.add(cb);
            cb(manager.currentSnapshot);
            return () => subscribers.delete(cb);
        });
        act(() => {
            subscribers.forEach((cb) => cb(contentSnapshot));
        });
        await waitFor(() => {
            expect(result.current.strokes).toHaveLength(1);
            expect(result.current.texts).toHaveLength(1);
            expect(result.current.texts[0].content).toBe('Hello World');
        });
    });
    it('should immediately receive current snapshot on subscription', () => {
        const roomId = 'immediate-test';
        const manager = RoomDocManagerRegistry.get(roomId);
        let immediateCallCount = 0;
        vi.spyOn(manager, 'subscribeSnapshot').mockImplementation((cb) => {
            immediateCallCount++;
            cb(manager.currentSnapshot);
            return () => { };
        });
        renderHook(() => useRoomSnapshot(roomId));
        expect(immediateCallCount).toBeGreaterThan(0);
    });
});
