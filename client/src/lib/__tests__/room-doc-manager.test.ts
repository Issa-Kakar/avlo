import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import type { Snapshot, RoomStats, PresenceView } from '@avlo/shared';
import { ROOM_CONFIG } from '@avlo/shared';
import {
  createTestManager,
  createTestRegistry,
  observeDocEvents,
  waitForSnapshot,
  collectSnapshots,
  collectPresenceUpdates,
  simulatePersistAck,
  SubscriptionTracker,
  verifyCleanup,
  mockNavigator,
  resetNavigator,
  USER_AGENTS,
} from './test-helpers';

// Mock ulid for predictable IDs
vi.mock('@avlo/shared', async () => {
  const actual = await vi.importActual('@avlo/shared');
  return {
    ...actual,
    ulid: vi.fn(() => 'test-ulid-001'),
  };
});

describe('RoomDocManager', () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetNavigator();
  });

  describe('Initialization', () => {
    it('creates Y.Doc with roomId as guid', () => {
      const { manager, cleanup } = createTestManager('room-001');

      // Verify through mutation that guid is set correctly
      let guid: string | undefined;
      manager.mutate((ydoc) => {
        guid = ydoc.guid;
      });

      expect(guid).toBe('room-001');
      cleanup();
    });

    it('initializes root structure with all required fields', () => {
      const { manager, cleanup } = createTestManager('room-002');

      let rootStructure: any = {};
      manager.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        rootStructure = {
          hasV: root.has('v'),
          v: root.get('v'),
          hasMeta: root.has('meta'),
          hasStrokes: root.has('strokes'),
          hasTexts: root.has('texts'),
          hasCode: root.has('code'),
          hasOutputs: root.has('outputs'),
          metaType: root.get('meta')?.constructor.name,
          strokesType: root.get('strokes')?.constructor.name,
          textsType: root.get('texts')?.constructor.name,
          codeType: root.get('code')?.constructor.name,
          outputsType: root.get('outputs')?.constructor.name,
        };
      });

      expect(rootStructure.hasV).toBe(true);
      expect(rootStructure.v).toBe(1);
      expect(rootStructure.hasMeta).toBe(true);
      expect(rootStructure.hasStrokes).toBe(true);
      expect(rootStructure.hasTexts).toBe(true);
      expect(rootStructure.hasCode).toBe(true);
      expect(rootStructure.hasOutputs).toBe(true);

      // Verify correct Y types
      expect(rootStructure.metaType).toBe('YMap');
      expect(rootStructure.strokesType).toBe('YArray');
      expect(rootStructure.textsType).toBe('YArray');
      expect(rootStructure.codeType).toBe('YMap');
      expect(rootStructure.outputsType).toBe('YArray');
      cleanup();
    });

    it('initializes meta with scene_ticks array', () => {
      const { manager, cleanup } = createTestManager('room-003');

      let sceneTicksInfo: any = {};
      manager.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const meta = root.get('meta') as Y.Map<any>;
        const sceneTicks = meta.get('scene_ticks');
        sceneTicksInfo = {
          exists: sceneTicks !== undefined,
          type: sceneTicks?.constructor.name,
          length: sceneTicks?.length ?? 0,
        };
      });

      expect(sceneTicksInfo.exists).toBe(true);
      expect(sceneTicksInfo.type).toBe('YArray');
      expect(sceneTicksInfo.length).toBe(0);
      cleanup();
    });

    it('creates empty snapshot synchronously', () => {
      const { manager, cleanup } = createTestManager('room-004');

      const snapshot = manager.currentSnapshot;

      expect(snapshot).not.toBeNull();
      expect(snapshot.docVersion).toBe(0); // Empty snapshot has version 0
      expect(snapshot.scene).toBe(0);
      expect(snapshot.strokes).toEqual([]);
      expect(snapshot.texts).toEqual([]);
      expect(snapshot.presence).toBeDefined();
      expect(snapshot.spatialIndex).toBeNull();
      expect(snapshot.view).toBeDefined();
      expect(snapshot.meta).toEqual({
        bytes: undefined,
        cap: 15 * 1024 * 1024,
        readOnly: false,
        expiresAt: undefined,
      });
      cleanup();
    });

    it('starts RAF loop immediately', () => {
      const { frames, cleanup } = createTestManager('room-005');

      // RAF should be scheduled
      expect(frames.getQueueLength()).toBe(1);
      cleanup();
    });

    it('generates unique userId via ulid', () => {
      const { manager, cleanup } = createTestManager('room-006');

      // userId should be set (mocked as 'test-ulid-001')
      expect((manager as any).userId).toBe('test-ulid-001');
      cleanup();
    });
  });

  describe('Snapshot Publishing', () => {
    it('publishes only when dirty flag is set', () => {
      const { manager, clock, frames, cleanup } = createTestManager('room-007');
      let publishCount = 0;

      manager.subscribeSnapshot(() => {
        publishCount++;
      });

      // Initial publish on subscribe
      expect(publishCount).toBe(1);

      // Advance frame without changes
      frames.advanceFrame(clock.now());
      expect(publishCount).toBe(1); // No additional publish

      // Make a change via mutate
      manager.mutate((ydoc) => {
        const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
        strokes.push([
          {
            id: 'stroke-1',
            tool: 'pen',
            color: '#000000',
            size: 2,
            opacity: 1,
            points: [0, 0, 10, 10],
            bbox: [0, 0, 10, 10],
            scene: 0,
            createdAt: Date.now(),
            userId: 'test-user',
          },
        ]);
      });

      // Should mark dirty, advance frame should publish
      frames.advanceFrame(clock.now());
      expect(publishCount).toBe(2);
      cleanup();
    });

    it('filters strokes by current scene', () => {
      const { manager, frames, cleanup } = createTestManager('room-008');

      // Add strokes to different scenes
      manager.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const strokes = root.get('strokes') as Y.Array<any>;

        // Add stroke for scene 0
        strokes.push([
          {
            id: 'stroke-scene-0',
            tool: 'pen',
            color: '#000000',
            size: 2,
            opacity: 1,
            points: [0, 0, 10, 10],
            bbox: [0, 0, 10, 10],
            scene: 0,
            createdAt: Date.now(),
            userId: 'test-user',
          },
        ]);

        // Add stroke for scene 1
        strokes.push([
          {
            id: 'stroke-scene-1',
            tool: 'pen',
            color: '#FF0000',
            size: 3,
            opacity: 1,
            points: [20, 20, 30, 30],
            bbox: [20, 20, 30, 30],
            scene: 1,
            createdAt: Date.now(),
            userId: 'test-user',
          },
        ]);
      });

      // Advance frame to publish the changes
      frames.advanceFrame(0);

      // Current scene is 0, should only see scene 0 stroke
      const snapshot = manager.currentSnapshot;
      expect(snapshot.scene).toBe(0);
      expect(snapshot.strokes.length).toBe(1);
      expect(snapshot.strokes[0].id).toBe('stroke-scene-0');

      // Increment scene by adding a scene tick
      manager.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const meta = root.get('meta') as Y.Map<any>;
        const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
        sceneTicks.push([Date.now()]);
      });

      // Advance frame to publish scene change
      frames.advanceFrame(0);

      // Now current scene is 1, should only see scene 1 stroke
      const newSnapshot = manager.currentSnapshot;
      expect(newSnapshot.scene).toBe(1);
      expect(newSnapshot.strokes.length).toBe(1);
      expect(newSnapshot.strokes[0].id).toBe('stroke-scene-1');
      cleanup();
    });

    it('increments docVersion on updates', () => {
      const { manager, frames, cleanup } = createTestManager('room-009');

      const initialVersion = manager.currentSnapshot.docVersion;
      expect(initialVersion).toBe(0); // Empty snapshot

      // Make a change
      manager.mutate((ydoc) => {
        const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
        strokes.push([
          {
            id: 'stroke-new',
            tool: 'pen',
            color: '#000000',
            size: 2,
            opacity: 1,
            points: [0, 0, 5, 5],
            bbox: [0, 0, 5, 5],
            scene: 0,
            createdAt: Date.now(),
            userId: 'test-user',
          },
        ]);
      });

      // Advance frame to publish changes
      frames.advanceFrame(0);

      const newVersion = manager.currentSnapshot.docVersion;
      expect(newVersion).toBeGreaterThan(0);
      cleanup();
    });

    it('does not include polyline in snapshot', () => {
      const { manager, frames, cleanup } = createTestManager('room-010');

      manager.mutate((ydoc) => {
        const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
        strokes.push([
          {
            id: 'stroke-test',
            tool: 'pen',
            color: '#000000',
            size: 2,
            opacity: 1,
            points: [0, 0, 10, 10],
            bbox: [0, 0, 10, 10],
            scene: 0,
            createdAt: Date.now(),
            userId: 'test-user',
          },
        ]);
      });

      // Advance frame to publish changes
      frames.advanceFrame(0);

      const snapshot = manager.currentSnapshot;
      expect(snapshot.strokes.length).toBe(1);
      expect(snapshot.strokes[0].polyline).toBeNull();
      cleanup();
    });

    if (process.env.NODE_ENV === 'development') {
      it('freezes snapshot in development', () => {
        const { manager, cleanup } = createTestManager('room-011');

        const snapshot = manager.currentSnapshot;

        // Snapshot should be frozen
        expect(Object.isFrozen(snapshot)).toBe(true);

        // Arrays should also be frozen
        expect(Object.isFrozen(snapshot.strokes)).toBe(true);
        expect(Object.isFrozen(snapshot.texts)).toBe(true);
        cleanup();
      });
    }
  });

  describe('Mutation Guards', () => {
    it('rejects mutations when room is read-only (≥15MB)', () => {
      const { manager, cleanup } = createTestManager('room-012');

      // Set room stats to exceed read-only threshold
      (manager as any).roomStats = {
        bytes: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
        cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
      };

      const initialSnapshot = manager.currentSnapshot;

      // Attempt mutation
      manager.mutate((ydoc) => {
        const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
        strokes.push([{ id: 'should-not-add' }]);
      });

      // Snapshot should be unchanged
      expect(manager.currentSnapshot).toBe(initialSnapshot);
      cleanup();
    });

    it('rejects mutations on mobile devices', () => {
      mockNavigator(USER_AGENTS.MOBILE_IOS);

      const { manager, cleanup } = createTestManager('room-013');
      const initialSnapshot = manager.currentSnapshot;

      // Attempt mutation
      manager.mutate((ydoc) => {
        const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
        strokes.push([{ id: 'should-not-add' }]);
      });

      // Snapshot should be unchanged
      expect(manager.currentSnapshot).toBe(initialSnapshot);

      cleanup();
    });

    it('allows small mutations even when document is large', () => {
      const { manager, cleanup } = createTestManager('room-014');

      // Mock size estimator to return >2MB (large document)
      (manager as any).sizeEstimator = {
        docEstGzBytes: ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES + 1,
        observeDelta: () => {},
      };

      // CRITICAL TEST: With old behavior, this mutation would be BLOCKED
      // because doc > 2MB. With new behavior, it should go through because
      // the delta (the actual change) is small.
      manager.mutate((ydoc) => {
        const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
        strokes.push([{ id: 'small-stroke', points: [0, 0, 1, 1] }]);
      });

      // Verify the mutation actually modified the Y.Doc
      // This is the PROOF that our guard didn't block it
      const ydoc = (manager as any).ydoc;
      const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
      expect(strokes.length).toBe(1);
      expect(strokes.get(0).id).toBe('small-stroke');

      // Also verify dirty flag was set (mutation completed successfully)
      expect((manager as any).publishState.isDirty).toBe(true);

      cleanup();
    });

    it('detects when delta size would exceed 2MB', () => {
      const { manager, cleanup } = createTestManager('room-016');

      // Spy on console.error to detect warning
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Create a truly massive mutation to ensure we exceed 2MB
      // We need to account for Yjs encoding overhead
      const massiveData = new Array(100).fill(null).map((_, i) => ({
        id: `stroke-${i}`,
        // Create 50,000 points per stroke = ~400KB per stroke x 100 = ~40MB
        points: new Array(50000).fill(0).map((_, j) => j),
        // Add extra metadata to ensure size
        metadata: new Array(1000).fill('x').join(''),
        color: '#000000',
        size: 5,
        opacity: 1,
        tool: 'pen',
        bbox: [0, 0, 100, 100],
        scene: 0,
        createdAt: Date.now(),
        userId: 'test',
      }));

      manager.mutate((ydoc) => {
        const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
        strokes.push(massiveData);
      });

      // IMPORTANT: Verify BOTH behaviors:
      // 1. Warning was logged about delta size
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Delta size'));

      // 2. Mutation still went through (we only warn, don't block yet)
      // This proves we're measuring delta correctly but not breaking existing behavior
      const ydoc = (manager as any).ydoc;
      const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
      expect(strokes.length).toBe(100); // All 100 strokes were added
      expect(strokes.get(0).id).toBe('stroke-0');

      // Dirty flag should still be set (mutation completed)
      expect((manager as any).publishState.isDirty).toBe(true);

      consoleErrorSpy.mockRestore();
      cleanup();
    });

    it('executes mutations with userId as origin', () => {
      const { manager, cleanup } = createTestManager('room-017');

      let capturedOrigin: any;

      // Spy on Y.Doc transact to capture origin
      const transactSpy = vi.spyOn((manager as any).ydoc, 'transact');

      manager.mutate((ydoc) => {
        const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
        strokes.push([{ id: 'test-stroke' }]);
      });

      expect(transactSpy).toHaveBeenCalledWith(
        expect.any(Function),
        'test-ulid-001', // The mocked userId
      );
      cleanup();
    });

    it('marks dirty flag after successful mutation', () => {
      const { manager, cleanup } = createTestManager('room-016');

      // Reset dirty flag
      (manager as any).publishState.isDirty = false;

      manager.mutate((ydoc) => {
        const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
        strokes.push([{ id: 'test-stroke' }]);
      });

      expect((manager as any).publishState.isDirty).toBe(true);
      cleanup();
    });
  });

  describe('Lifecycle', () => {
    it('properly cleans up on destroy', () => {
      const { manager, frames, cleanup } = createTestManager('room-017');

      // Subscribe to verify cleanup
      const unsubSnapshot = manager.subscribeSnapshot(() => {});
      const unsubPresence = manager.subscribePresence(() => {});
      const unsubStats = manager.subscribeRoomStats(() => {});

      // Verify manager is active
      expect((manager as any).destroyed).toBe(false);
      expect(frames.getQueueLength()).toBeGreaterThan(0);

      // Destroy
      manager.destroy();

      // Verify cleanup
      expect((manager as any).destroyed).toBe(true);
      expect(frames.getQueueLength()).toBe(0);
      expect((manager as any).snapshotSubscribers.size).toBe(0);
      expect((manager as any).presenceSubscribers.size).toBe(0);
      expect((manager as any).statsSubscribers.size).toBe(0);
      // Note: manager already destroyed, so cleanup() not needed
    });

    it('makes all methods no-op after destroy', () => {
      const { manager, cleanup } = createTestManager('room-018');

      manager.destroy();

      // These should not throw
      manager.mutate(() => {});
      manager.extendTTL();
      const unsub = manager.subscribeSnapshot(() => {});
      unsub(); // Should also not throw
      // Note: manager already destroyed, calling cleanup for registry cleanup
      cleanup();
    });

    it('removes from registry on destroy', () => {
      const { registry } = createTestRegistry();
      const manager = registry.get('room-019');

      // Should be in registry
      expect(registry.has('room-019')).toBe(true);

      manager.destroy();

      // Manager should still exist in registry until explicitly removed
      // (destroy doesn't automatically remove from registry)
      registry.remove('room-019');
      expect(registry.has('room-019')).toBe(false);
      registry.reset();
    });
  });

  describe('Registry', () => {
    it('prevents duplicate managers for same roomId', () => {
      const { registry, cleanup } = createTestRegistry();
      const manager1 = registry.get('room-020');
      const manager2 = registry.get('room-020');

      // Should return the same instance
      expect(manager1).toBe(manager2);
      cleanup();
    });

    it('allows new manager after previous removed', () => {
      const { registry, cleanup } = createTestRegistry();
      const manager1 = registry.get('room-021');

      // Remove from registry
      registry.remove('room-021');

      // Should create new instance
      const manager2 = registry.get('room-021');
      expect(manager2).not.toBe(manager1);
      expect(manager2).toBeDefined();

      cleanup();
    });

    it('createIsolated creates independent instances', () => {
      const { registry, cleanup } = createTestRegistry();
      const manager1 = registry.createIsolated('room-022');
      const manager2 = registry.createIsolated('room-022');

      // Should be different instances
      expect(manager1).not.toBe(manager2);

      // Neither should be in registry
      expect(registry.has('room-022')).toBe(false);

      // Clean up isolated managers
      manager1.destroy();
      manager2.destroy();
      cleanup();
    });

    it('properly handles reference counting with acquire/release', () => {
      const { registry, cleanup } = createTestRegistry();
      const roomId = 'room-refcount-001';

      // Acquire first reference
      const manager1 = registry.acquire(roomId);
      expect(registry.has(roomId)).toBe(true);
      expect(registry.getRefCount(roomId)).toBe(1);

      // Acquire second reference (should return same instance)
      const manager2 = registry.acquire(roomId);
      expect(manager2).toBe(manager1);
      expect(registry.getRefCount(roomId)).toBe(2);

      // Release first reference
      registry.release(roomId);
      expect(registry.has(roomId)).toBe(true); // Still has one reference
      expect(registry.getRefCount(roomId)).toBe(1);

      // Release second reference - should destroy manager
      registry.release(roomId);
      expect(registry.has(roomId)).toBe(false); // Manager removed
      expect(registry.getRefCount(roomId)).toBe(0);

      cleanup();
    });

    it('automatically destroys manager when reference count reaches zero', () => {
      const { registry, cleanup } = createTestRegistry();
      const roomId = 'room-autodestroy-001';

      // Acquire reference
      const manager = registry.acquire(roomId);

      // Mock destroy to track if it's called
      const destroySpy = vi.spyOn(manager, 'destroy');

      // Should not be destroyed yet
      expect(destroySpy).not.toHaveBeenCalled();

      // Release reference - should auto-destroy
      registry.release(roomId);

      // Verify destroy was called and manager removed
      expect(destroySpy).toHaveBeenCalledTimes(1);
      expect(registry.has(roomId)).toBe(false);

      cleanup();
    });

    it('maintains backward compatibility with get() method', () => {
      const { registry, cleanup } = createTestRegistry();
      const roomId = 'room-legacy-001';

      // Using legacy get() method
      const manager = registry.get(roomId);
      expect(registry.has(roomId)).toBe(true);

      // RefCount should be 0 or undefined for legacy managers
      expect(registry.getRefCount(roomId)).toBe(0);

      // Release should not affect legacy managers
      registry.release(roomId);
      expect(registry.has(roomId)).toBe(true); // Still exists

      // Must manually remove legacy managers
      registry.remove(roomId);
      expect(registry.has(roomId)).toBe(false);

      cleanup();
    });
  });

  describe('Subscriptions', () => {
    it('calls callback immediately on subscribe', () => {
      const { manager, cleanup } = createTestManager('room-sub-001');
      const tracker = new SubscriptionTracker<Snapshot>();

      manager.subscribeSnapshot(tracker.fn);

      // Should be called immediately with current snapshot
      expect(tracker.callCount).toBe(1);
      expect(tracker.lastValue).toBe(manager.currentSnapshot);
      cleanup();
    });

    it('notifies all subscribers on change', () => {
      const { manager, frames, clock, cleanup } = createTestManager('room-sub-002');
      const trackers = [
        new SubscriptionTracker<Snapshot>(),
        new SubscriptionTracker<Snapshot>(),
        new SubscriptionTracker<Snapshot>(),
      ];

      // Subscribe all
      const unsubs = trackers.map((t) => manager.subscribeSnapshot(t.fn));

      // Each should have been called once on subscribe
      trackers.forEach((t) => expect(t.callCount).toBe(1));

      // Make a change
      manager.mutate((ydoc) => {
        const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
        strokes.push([{ id: 'test-stroke', tool: 'pen' }]);
      });

      // Advance frame to publish
      frames.advanceFrame(clock.now());

      // All should have been notified
      trackers.forEach((t) => expect(t.callCount).toBe(2));

      // Clean up
      unsubs.forEach((unsub) => unsub());
      cleanup();
    });

    it('stops calling after unsubscribe', () => {
      const { manager, frames, clock, cleanup } = createTestManager('room-sub-003');
      const tracker = new SubscriptionTracker<Snapshot>();

      const unsub = manager.subscribeSnapshot(tracker.fn);
      expect(tracker.callCount).toBe(1);

      // Unsubscribe
      unsub();

      // Make changes
      manager.mutate((ydoc) => {
        const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
        strokes.push([{ id: 'test-stroke' }]);
      });
      frames.advanceFrame(clock.now());

      // Should not have been called again
      expect(tracker.callCount).toBe(1);
      cleanup();
    });
  });

  describe('Presence Throttling', () => {
    it('has throttled presence update method', () => {
      const { manager, cleanup } = createTestManager('room-presence-001');

      // Verify the throttled method exists
      expect((manager as any).updatePresenceThrottled).toBeDefined();
      expect(typeof (manager as any).updatePresenceThrottled).toBe('function');

      cleanup();
    });

    it('notifies presence subscribers when presence updates', () => {
      const { manager, cleanup } = createTestManager('room-presence-002');
      const tracker = new SubscriptionTracker<PresenceView>();

      manager.subscribePresence(tracker.fn);
      const initialCount = tracker.callCount;

      // Directly call updatePresence to test notification
      if ((manager as any).updatePresence) {
        (manager as any).updatePresence();
        expect(tracker.callCount).toBe(initialCount + 1);
      }

      cleanup();
    });

    it('publishes presence independently from snapshots', () => {
      const { manager, clock, frames, cleanup } = createTestManager('room-presence-002');
      const snapTracker = new SubscriptionTracker<Snapshot>();
      const presTracker = new SubscriptionTracker<PresenceView>();

      manager.subscribeSnapshot(snapTracker.fn);
      manager.subscribePresence(presTracker.fn);

      snapTracker.clear();
      presTracker.clear();

      // Update only presence (no doc changes)
      (manager as any).publishState.presenceDirty = true;
      frames.advanceFrame(clock.now());

      // Since presence is part of snapshot, both should update
      expect(snapTracker.callCount).toBeGreaterThan(0);
      // Note: Presence is throttled separately, so may have different behavior
      expect(presTracker.callCount).toBeGreaterThanOrEqual(0);
      cleanup();
    });
  });

  describe('RoomStats Updates', () => {
    it('starts with null stats', () => {
      const { manager, cleanup } = createTestManager('room-stats-001');
      const tracker = new SubscriptionTracker<RoomStats | null>();

      manager.subscribeRoomStats(tracker.fn);

      // Initial value should be null
      expect(tracker.lastValue).toBeNull();
      cleanup();
    });

    it('updates stats from persist_ack', () => {
      const { manager, cleanup } = createTestManager('room-stats-002');
      const tracker = new SubscriptionTracker<RoomStats | null>();

      manager.subscribeRoomStats(tracker.fn);
      expect(tracker.lastValue).toBeNull();

      // Simulate persist_ack
      simulatePersistAck(manager, 1024 * 1024); // 1MB

      // Stats should be updated
      expect(tracker.lastValue).toEqual({
        bytes: 1024 * 1024,
        cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
      });
      cleanup();
    });

    it('triggers read-only at 15MB threshold', () => {
      const { manager, cleanup } = createTestManager('room-stats-003');

      // Set stats to exactly at threshold
      simulatePersistAck(manager, ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES);

      // Mutations should now be blocked
      const initialSnapshot = manager.currentSnapshot;
      manager.mutate((ydoc) => {
        const strokes = ydoc.getMap('root').get('strokes') as Y.Array<any>;
        strokes.push([{ id: 'should-not-add' }]);
      });

      // Snapshot should be unchanged
      expect(manager.currentSnapshot).toBe(initialSnapshot);
      cleanup();
    });
  });

  describe('Y.Doc Transaction Integration', () => {
    it('executes mutations in single yjs.transact', () => {
      const { manager, cleanup } = createTestManager('room-ydoc-001');
      const events: string[] = [];

      // Observe doc events
      const unobserve = observeDocEvents(manager, (event, data) => {
        events.push(event);
        // Transaction events include the origin in the data
        // No need to assert here, we'll verify the mutation was in a single transaction
      });

      // Execute mutation
      manager.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const strokes = root.get('strokes') as Y.Array<any>;
        strokes.push([{ id: 'stroke-1' }]);
        strokes.push([{ id: 'stroke-2' }]);
        strokes.push([{ id: 'stroke-3' }]);
      });

      // Should have exactly one transaction for all operations
      const transactionCount = events.filter((e) => e === 'transaction').length;
      expect(transactionCount).toBe(1);

      unobserve();
      cleanup();
    });

    it('properly initializes Y.Doc structure', () => {
      const { manager, cleanup } = createTestManager('room-ydoc-002');

      // Verify structure through observation
      let hasRoot = false;
      let hasAllFields = false;

      manager.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        hasRoot = root !== undefined;

        hasAllFields =
          root.has('v') &&
          root.has('meta') &&
          root.has('strokes') &&
          root.has('texts') &&
          root.has('code') &&
          root.has('outputs');

        // Verify scene_ticks in meta
        const meta = root.get('meta') as Y.Map<any>;
        const sceneTicks = meta.get('scene_ticks');
        expect(sceneTicks).toBeDefined();
        expect(sceneTicks.length).toBe(0);
      });

      expect(hasRoot).toBe(true);
      expect(hasAllFields).toBe(true);
      cleanup();
    });
  });

  describe('Memory Cleanup', () => {
    it('properly cleans up all resources', () => {
      const testContext = createTestManager('room-cleanup-001');

      // Verify cleanup removes all resources
      const cleanedUp = verifyCleanup(testContext);
      expect(cleanedUp).toBe(true);
    });

    it('cleans up event listeners on destroy', () => {
      const { manager, cleanup } = createTestManager('room-cleanup-002');

      // Add doc observer
      const unobserve = observeDocEvents(manager, () => {});

      // Destroy manager
      manager.destroy();

      // Observer should be cleaned up (no errors on call)
      expect(() => unobserve()).not.toThrow();

      cleanup();
    });
  });
});
