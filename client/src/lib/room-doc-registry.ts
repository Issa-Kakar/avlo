/**
 * RoomDocManagerRegistry - Manages RoomDocManager instances per room
 */

import type { RoomId } from '@avlo/shared';
import { RoomDocManagerImpl, IRoomDocManager, RoomDocManagerOptions } from './room-doc-manager';

// Registry class for managing RoomDocManager instances
export class RoomDocManagerRegistry {
  private managers = new Map<RoomId, IRoomDocManager>();
  private refCounts = new Map<RoomId, number>();
  private defaultOptions?: RoomDocManagerOptions;

  /**
   * Set default options for all new managers
   * Useful for test environments
   */
  setDefaultOptions(options: RoomDocManagerOptions): void {
    this.defaultOptions = options;
  }

  /**
   * Get or create a manager for a room
   * Ensures singleton per room within this registry instance
   * @deprecated Use acquire() instead for proper reference counting
   */
  get(roomId: RoomId, options?: RoomDocManagerOptions): IRoomDocManager {
    console.warn(
      `[Registry] DEPRECATED get() method called for roomId: ${roomId} - should use acquire() instead`,
    );
    // For backward compatibility, delegate to acquire
    // But don't increment ref count (maintains old behavior for tests)
    let manager = this.managers.get(roomId);

    if (!manager) {
      // Use provided options, fall back to default options, or use browser defaults
      const finalOptions = options ?? this.defaultOptions;
      manager = new RoomDocManagerImpl(roomId, finalOptions);
      this.managers.set(roomId, manager);
      // Don't set ref count for backward compatibility with tests
    }

    return manager;
  }

  /**
   * Acquire a reference to a manager for a room
   * Creates the manager if it doesn't exist, increments reference count
   * Must be paired with release() when done
   */
  acquire(roomId: RoomId, options?: RoomDocManagerOptions): IRoomDocManager {
    let manager = this.managers.get(roomId);

    if (!manager) {
      const finalOptions = options ?? this.defaultOptions;
      manager = new RoomDocManagerImpl(roomId, finalOptions);
      this.managers.set(roomId, manager);
      this.refCounts.set(roomId, 0);
    }

    // Increment reference count
    const currentCount = this.refCounts.get(roomId) || 0;
    this.refCounts.set(roomId, currentCount + 1);

    return manager;
  }

  /**
   * Release a reference to a manager
   * Decrements reference count and destroys manager if count reaches 0
   */
  release(roomId: RoomId): void {
    const count = this.refCounts.get(roomId);
    if (count === undefined) {
      // If no refcount, this manager was created with legacy get() method
      // Don't do anything to maintain backward compatibility
      return;
    }

    const newCount = count - 1;

    if (newCount <= 0) {
      // Reference count reached 0, destroy and remove
      const manager = this.managers.get(roomId);
      if (manager) {
        manager.destroy();
      }
      this.managers.delete(roomId);
      this.refCounts.delete(roomId);
    } else {
      this.refCounts.set(roomId, newCount);
    }
  }

  /**
   * Create an isolated manager instance for testing
   * This manager is NOT tracked by the registry
   */
  createIsolated(roomId: RoomId, options?: RoomDocManagerOptions): IRoomDocManager {
    const finalOptions = options ?? this.defaultOptions;
    return new RoomDocManagerImpl(roomId, finalOptions);
  }

  has(roomId: RoomId): boolean {
    return this.managers.has(roomId);
  }

  /**
   * Get the reference count for a room (for debugging/testing)
   */
  getRefCount(roomId: RoomId): number {
    return this.refCounts.get(roomId) || 0;
  }

  remove(roomId: RoomId): void {
    const manager = this.managers.get(roomId);
    if (manager) {
      manager.destroy();
      this.managers.delete(roomId);
      this.refCounts.delete(roomId);
    }
  }

  /**
   * Destroy all managers and clear the registry
   * Used for cleanup in tests and app teardown
   */
  destroyAll(): void {
    this.managers.forEach((manager) => manager.destroy());
    this.managers.clear();
    this.refCounts.clear();
    this.defaultOptions = undefined;
  }

  /**
   * Reset the registry completely (for tests)
   * More thorough than destroyAll - resets all state
   */
  reset(): void {
    this.destroyAll();
  }

  /**
   * Get the count of managed instances (for debugging/testing)
   */
  size(): number {
    return this.managers.size;
  }
}

// Factory function to create a new registry
export function createRoomDocManagerRegistry(): RoomDocManagerRegistry {
  return new RoomDocManagerRegistry();
}

// Export manager type alias
export type RoomDocManager = IRoomDocManager;
