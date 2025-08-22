import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRoomDoc } from '../use-room-doc';
import { RoomDocManagerRegistry } from '../../lib/room-doc-manager';
describe('useRoomDoc', () => {
    afterEach(() => {
        RoomDocManagerRegistry.destroyAll();
    });
    it('should return a RoomDocManager instance', () => {
        const { result } = renderHook(() => useRoomDoc('test-room'));
        expect(result.current).toBeDefined();
        expect(result.current).toHaveProperty('currentSnapshot');
        expect(result.current).toHaveProperty('subscribeSnapshot');
        expect(result.current).toHaveProperty('subscribePresence');
        expect(result.current).toHaveProperty('subscribeRoomStats');
        expect(result.current).toHaveProperty('write');
        expect(result.current).toHaveProperty('extendTTL');
        expect(result.current).toHaveProperty('destroy');
    });
    it('should return the same manager instance for the same roomId', () => {
        const { result: result1 } = renderHook(() => useRoomDoc('room-1'));
        const { result: result2 } = renderHook(() => useRoomDoc('room-1'));
        expect(result1.current).toBe(result2.current);
    });
    it('should return different managers for different roomIds', () => {
        const { result: result1 } = renderHook(() => useRoomDoc('room-1'));
        const { result: result2 } = renderHook(() => useRoomDoc('room-2'));
        expect(result1.current).not.toBe(result2.current);
    });
    it('should maintain manager reference across re-renders', () => {
        const { result, rerender } = renderHook(() => useRoomDoc('test-room'));
        const firstManager = result.current;
        rerender();
        expect(result.current).toBe(firstManager);
    });
    it('should use singleton registry', () => {
        const getSpy = vi.spyOn(RoomDocManagerRegistry, 'get');
        renderHook(() => useRoomDoc('registry-test'));
        expect(getSpy).toHaveBeenCalledWith('registry-test');
    });
    it('should not destroy manager on unmount', () => {
        const { result, unmount } = renderHook(() => useRoomDoc('unmount-test'));
        const manager = result.current;
        const destroySpy = vi.spyOn(manager, 'destroy');
        unmount();
        // Manager should not be destroyed by the hook
        expect(destroySpy).not.toHaveBeenCalled();
        // Manager should still exist in registry
        expect(RoomDocManagerRegistry.has('unmount-test')).toBe(true);
    });
});
