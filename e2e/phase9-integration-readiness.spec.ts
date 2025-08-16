import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    avloPhase9: {
      roomsStore: any;
      aliasStore: any;
      resolveAlias: any;
      setAlias: any;
      upsertVisit: any;
      handlePublish: any;
      listRooms: any;
      removeFromList: any;
      deleteLocalCopy: any;
    };
  }
}

test.describe('Phase 9 - Integration Readiness Tests', () => {
  
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
  });

  test('Realistic user workflow - creating and managing rooms', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, handlePublish, listRooms, resolveAlias } = window.avloPhase9;
      
      try {
        // Simulate a realistic user workflow
        
        // Day 1: User creates their first room locally
        await upsertVisit('local-my-first-room', {
          title: 'My First Whiteboard',
          provisional: true
        });
        
        // Day 1: User visits another existing room
        await upsertVisit('room-shared-abc123', {
          title: 'Shared Meeting Room',
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });
        
        // Day 2: User publishes their local room
        await handlePublish('local-my-first-room', 'server-room-xyz789', 'My First Whiteboard (Published)');
        
        // Day 2: User continues working on the published room (using alias)
        await upsertVisit('local-my-first-room', {
          title: 'My First Whiteboard (Updated)'
        });
        
        // Day 3: User creates another local room
        await upsertVisit('local-quick-notes', {
          title: 'Quick Notes',
          provisional: true
        });
        
        // Day 3: User revisits the shared room
        await upsertVisit('room-shared-abc123', {
          title: 'Shared Meeting Room (Updated)'
        });
        
        // Check final state
        const rooms = await listRooms();
        const firstRoomResolved = await resolveAlias('local-my-first-room');
        
        // Verify expected rooms exist
        const publishedRoom = rooms.find(r => r.roomId === 'server-room-xyz789');
        const sharedRoom = rooms.find(r => r.roomId === 'room-shared-abc123');
        const localRoom = rooms.find(r => r.roomId === 'local-quick-notes');
        
        // Verify sorting (most recently accessed first)
        const roomOrder = rooms.map(r => r.roomId);
        
        return {
          success: true,
          totalRooms: rooms.length,
          aliasResolves: firstRoomResolved === 'server-room-xyz789',
          hasPublishedRoom: !!publishedRoom,
          hasSharedRoom: !!sharedRoom,
          hasLocalRoom: !!localRoom,
          publishedRoomTitle: publishedRoom?.title,
          sharedRoomTitle: sharedRoom?.title,
          mostRecentFirst: roomOrder[0] === 'room-shared-abc123', // Last visited
          roomOrder: roomOrder.slice(0, 5) // Show first 5 for debugging
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.aliasResolves).toBe(true);
    expect(result.hasPublishedRoom).toBe(true);
    expect(result.hasSharedRoom).toBe(true);
    expect(result.hasLocalRoom).toBe(true);
    expect(result.publishedRoomTitle).toBe('My First Whiteboard (Updated)');
    expect(result.mostRecentFirst).toBe(true);
  });

  test('Phase 2 integration scenarios - router compatibility', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, resolveAlias, listRooms } = window.avloPhase9;
      
      try {
        // Simulate scenarios that Phase 2 router integration will encounter
        
        // Scenario 1: User navigates to /rooms/local-xyz (should resolve)
        await upsertVisit('local-draft-board', {
          title: 'Draft Board',
          provisional: true
        });
        
        const localRoomId = await resolveAlias('local-draft-board');
        
        // Scenario 2: User navigates to /rooms/server-abc123 (regular room)
        await upsertVisit('server-abc123', {
          title: 'Server Room',
          expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
        });
        
        const serverRoomId = await resolveAlias('server-abc123');
        
        // Scenario 3: User navigates to /rooms/random-id (new room)
        await upsertVisit('random-new-room-id', {
          title: 'Random New Room'
        });
        
        const newRoomId = await resolveAlias('random-new-room-id');
        
        // Scenario 4: Check room list for UI display
        const roomsForUI = await listRooms();
        
        // Verify data structure matches what UI expects
        const uiCompatible = roomsForUI.every(room => 
          typeof room.roomId === 'string' &&
          typeof room.title === 'string' &&
          typeof room.last_opened === 'string' &&
          !isNaN(new Date(room.last_opened).getTime())
        );
        
        return {
          success: true,
          localRoomResolves: localRoomId === 'local-draft-board',
          serverRoomResolves: serverRoomId === 'server-abc123',
          newRoomResolves: newRoomId === 'random-new-room-id',
          roomsForUICount: roomsForUI.length,
          uiDataStructureValid: uiCompatible,
          sampleRoom: roomsForUI[0] // For structure verification
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.localRoomResolves).toBe(true);
    expect(result.serverRoomResolves).toBe(true);
    expect(result.newRoomResolves).toBe(true);
    expect(result.uiDataStructureValid).toBe(true);
    expect(result.roomsForUICount).toBeGreaterThan(0);
  });

  test('Phase 3+ integration scenarios - Y.js document lifecycle', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, handlePublish, deleteLocalCopy, removeFromList } = window.avloPhase9;
      
      try {
        // Simulate scenarios that will happen with Y.js document management
        
        // Scenario 1: Create a room that will have a Y.js document
        await upsertVisit('room-with-yjs-doc', {
          title: 'Room with Y.js Document',
          provisional: false
        });
        
        // Scenario 2: Provisional room that gets published (Y.js doc transitions)
        await upsertVisit('local-yjs-draft', {
          title: 'Draft with Y.js',
          provisional: true
        });
        
        await handlePublish('local-yjs-draft', 'server-yjs-published', 'Published Y.js Room');
        
        // Scenario 3: Test deleteLocalCopy with mock Y.js cleanup
        let yjsCleanupCalled = false;
        let cleanupRoomId = '';
        
        await deleteLocalCopy('room-with-yjs-doc', async () => {
          yjsCleanupCalled = true;
          cleanupRoomId = 'room-with-yjs-doc';
          // In real Phase 3, this would:
          // - Clear y-indexeddb for this room
          // - Dispose of Y.Doc instance
          // - Clean up any providers
        });
        
        // Scenario 4: Test removeFromList (keeps Y.js doc but removes from UI)
        await removeFromList('server-yjs-published');
        
        return {
          success: true,
          yjsCleanupCalled,
          cleanupRoomId,
          contractRespected: yjsCleanupCalled && cleanupRoomId === 'room-with-yjs-doc'
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.yjsCleanupCalled).toBe(true);
    expect(result.contractRespected).toBe(true);
  });

  test('Offline-first behavior simulation', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, listRooms } = window.avloPhase9;
      
      try {
        // Simulate offline-first behavior (all storage is local)
        
        // Create multiple rooms while "offline"
        const offlineRooms = [
          { id: 'local-offline-1', title: 'Offline Room 1' },
          { id: 'local-offline-2', title: 'Offline Room 2' },
          { id: 'local-offline-3', title: 'Offline Room 3' }
        ];
        
        for (const room of offlineRooms) {
          await upsertVisit(room.id, {
            title: room.title,
            provisional: true
          });
        }
        
        // Verify all rooms are stored locally
        const allRooms = await listRooms();
        const offlineRoomsStored = offlineRooms.every(room => 
          allRooms.some(stored => stored.roomId === room.id && stored.title === room.title)
        );
        
        // Simulate working on rooms while offline
        await upsertVisit('local-offline-1', {
          title: 'Offline Room 1 (Updated)'
        });
        
        // Verify updates persist
        const updatedRooms = await listRooms();
        const updatePersisted = updatedRooms.some(r => 
          r.roomId === 'local-offline-1' && r.title === 'Offline Room 1 (Updated)'
        );
        
        return {
          success: true,
          offlineRoomsStored,
          updatePersisted,
          totalOfflineRooms: offlineRooms.length,
          actualStoredRooms: allRooms.filter(r => r.roomId.startsWith('local-offline-')).length
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.offlineRoomsStored).toBe(true);
    expect(result.updatePersisted).toBe(true);
    expect(result.actualStoredRooms).toBe(3);
  });

  test('Room expiry and TTL handling readiness', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, listRooms } = window.avloPhase9;
      
      try {
        const now = new Date();
        
        // Create rooms with different expiry scenarios
        
        // Room expiring soon (1 day)
        await upsertVisit('room-expires-soon', {
          title: 'Expires Soon',
          expires_at: new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString()
        });
        
        // Room with long expiry (30 days)
        await upsertVisit('room-long-expiry', {
          title: 'Long Expiry',
          expires_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
        });
        
        // Room without expiry (should be handled gracefully)
        await upsertVisit('room-no-expiry', {
          title: 'No Expiry'
        });
        
        // Room that's already expired (edge case)
        await upsertVisit('room-already-expired', {
          title: 'Already Expired',
          expires_at: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString()
        });
        
        const rooms = await listRooms();
        
        // Calculate days until expiry for each room
        const roomsWithExpiryInfo = rooms
          .filter(r => r.roomId.includes('expires') || r.roomId.includes('expiry') || r.roomId.includes('already'))
          .map(room => {
            if (!room.expires_at) return { ...room, daysUntilExpiry: null };
            
            const expiryDate = new Date(room.expires_at);
            const daysUntilExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
            
            return { ...room, daysUntilExpiry };
          });
        
        return {
          success: true,
          totalRooms: roomsWithExpiryInfo.length,
          soonExpiryDays: roomsWithExpiryInfo.find(r => r.roomId === 'room-expires-soon')?.daysUntilExpiry,
          longExpiryDays: roomsWithExpiryInfo.find(r => r.roomId === 'room-long-expiry')?.daysUntilExpiry,
          noExpiryHandled: roomsWithExpiryInfo.find(r => r.roomId === 'room-no-expiry')?.daysUntilExpiry === null,
          expiredRoomDays: roomsWithExpiryInfo.find(r => r.roomId === 'room-already-expired')?.daysUntilExpiry,
          allExpiryDataValid: roomsWithExpiryInfo.every(r => 
            r.daysUntilExpiry === null || typeof r.daysUntilExpiry === 'number'
          )
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.soonExpiryDays).toBe(1);
    expect(result.longExpiryDays).toBe(30);
    expect(result.noExpiryHandled).toBe(true);
    expect(result.expiredRoomDays).toBeDefined();
    expect(result.expiredRoomDays).toBeLessThan(0);
    expect(result.allExpiryDataValid).toBe(true);
  });

  test('UI panel data format compatibility', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, listRooms, handlePublish } = window.avloPhase9;
      
      try {
        // Create rooms that match what the UI panel expects to display
        
        // Room with all possible fields
        await upsertVisit('ui-test-complete', {
          title: 'Complete Room Data',
          provisional: false,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });
        
        // Provisional room
        await upsertVisit('local-ui-test-provisional', {
          title: 'Provisional Room',
          provisional: true
        });
        
        // Published room (from provisional)
        await handlePublish('local-ui-test-provisional', 'ui-test-published', 'Published Room');
        
        const rooms = await listRooms();
        
        // Verify data format matches UI expectations
        const uiDataChecks = rooms.map(room => ({
          roomId: room.roomId,
          hasValidId: typeof room.roomId === 'string' && room.roomId.length > 0,
          hasValidTitle: typeof room.title === 'string' && room.title.length > 0,
          hasValidTimestamp: typeof room.last_opened === 'string' && !isNaN(new Date(room.last_opened).getTime()),
          expiryFormatValid: !room.expires_at || (typeof room.expires_at === 'string' && !isNaN(new Date(room.expires_at).getTime())),
          provisionalFormatValid: room.provisional === undefined || typeof room.provisional === 'boolean'
        }));
        
        const allDataValid = uiDataChecks.every(check => 
          check.hasValidId && 
          check.hasValidTitle && 
          check.hasValidTimestamp && 
          check.expiryFormatValid && 
          check.provisionalFormatValid
        );
        
        // Test specific room data that UI will need
        const completeRoom = rooms.find(r => r.roomId === 'ui-test-complete');
        const publishedRoom = rooms.find(r => r.roomId === 'ui-test-published');
        
        return {
          success: true,
          allDataValid,
          totalValidRooms: uiDataChecks.filter(check => 
            check.hasValidId && check.hasValidTitle && check.hasValidTimestamp
          ).length,
          completeRoomValid: !!completeRoom && !!completeRoom.expires_at,
          publishedRoomValid: !!publishedRoom && publishedRoom.title === 'Published Room',
          dataFormatSample: rooms[0] // For debugging format issues
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.allDataValid).toBe(true);
    expect(result.completeRoomValid).toBe(true);
    expect(result.publishedRoomValid).toBe(true);
  });

  test('Browser refresh and page reload persistence', async ({ page }) => {
    // Create data
    await page.evaluate(async () => {
      if (!window.avloPhase9) throw new Error('Phase 9 not available');
      
      const { upsertVisit, handlePublish } = window.avloPhase9;
      
      await upsertVisit('persist-test-1', { title: 'Persist Test 1' });
      await upsertVisit('local-persist-test', { title: 'Local Persist Test', provisional: true });
      await handlePublish('local-persist-test', 'server-persist-test', 'Published Persist Test');
    });
    
    // Simulate browser refresh
    await page.reload();
    await page.waitForTimeout(1000);
    
    // Verify data persists
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available after reload' };
      
      const { listRooms, resolveAlias } = window.avloPhase9;
      
      try {
        const rooms = await listRooms();
        const aliasResolution = await resolveAlias('local-persist-test');
        
        return {
          success: true,
          roomsAfterReload: rooms.length,
          hasPersistTest1: rooms.some(r => r.roomId === 'persist-test-1'),
          hasPublishedRoom: rooms.some(r => r.roomId === 'server-persist-test'),
          aliasStillWorks: aliasResolution === 'server-persist-test'
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.hasPersistTest1).toBe(true);
    expect(result.hasPublishedRoom).toBe(true);
    expect(result.aliasStillWorks).toBe(true);
  });
});