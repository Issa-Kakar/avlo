import { test, expect } from '@playwright/test';

// Type declaration for Phase 9 test exports
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

test.describe('Phase 9 - Comprehensive Room Management Tests', () => {
  
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
    
    // Clear existing data before each test
    await page.evaluate(async () => {
      if (window.avloPhase9) {
        const { roomsStore, aliasStore } = window.avloPhase9;
        
        // Clear all rooms
        const allRooms = await roomsStore.all();
        for (const room of allRooms) {
          await roomsStore.del(room.roomId);
        }
        
        // Clear all aliases
        // Note: IndexedDB doesn't have a direct way to clear all from aliasStore, 
        // but since we're testing from scratch each time, this should be sufficient
      }
    });
  });

  test('Room creation workflow with different ID types', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, listRooms } = window.avloPhase9;
      
      try {
        // Create a regular room
        await upsertVisit('room-abc123', {
          title: 'Regular Room',
          provisional: false,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });
        
        // Create a provisional local room
        await upsertVisit('local-provisional-123', {
          title: 'Provisional Local Room',
          provisional: true
        });
        
        // Create another regular room with minimal options
        await upsertVisit('room-minimal', {
          title: 'Minimal Room'
        });
        
        const rooms = await listRooms();
        
        return {
          success: true,
          roomCount: rooms.length,
          hasRegularRoom: rooms.some(r => r.roomId === 'room-abc123' && r.title === 'Regular Room'),
          hasProvisionalRoom: rooms.some(r => r.roomId === 'local-provisional-123' && r.provisional === true),
          hasMinimalRoom: rooms.some(r => r.roomId === 'room-minimal' && r.title === 'Minimal Room'),
          roomTitles: rooms.map(r => r.title)
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.roomCount).toBe(3);
    expect(result.hasRegularRoom).toBe(true);
    expect(result.hasProvisionalRoom).toBe(true);
    expect(result.hasMinimalRoom).toBe(true);
  });

  test('Room visit order and sorting', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, listRooms } = window.avloPhase9;
      
      try {
        // Create rooms in a specific order with delays to ensure different timestamps
        await upsertVisit('room-first', { title: 'First Room' });
        
        // Small delay to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 10));
        
        await upsertVisit('room-second', { title: 'Second Room' });
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        await upsertVisit('room-third', { title: 'Third Room' });
        
        // Now revisit the first room to make it most recent
        await new Promise(resolve => setTimeout(resolve, 10));
        await upsertVisit('room-first', { title: 'First Room Revisited' });
        
        const rooms = await listRooms();
        
        return {
          success: true,
          roomOrder: rooms.map(r => r.roomId),
          firstRoomTitle: rooms[0]?.title,
          mostRecentIsFirst: rooms[0]?.roomId === 'room-first'
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.mostRecentIsFirst).toBe(true);
    expect(result.firstRoomTitle).toBe('First Room Revisited');
  });

  test('Publishing workflow - provisional to server room', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, handlePublish, listRooms, resolveAlias } = window.avloPhase9;
      
      try {
        // Create a provisional room
        await upsertVisit('local-draft-room', {
          title: 'My Draft Room',
          provisional: true
        });
        
        // Simulate publishing the room
        await handlePublish('local-draft-room', 'server-published-abc123', 'Published Room Title');
        
        // Test alias resolution
        const resolvedId = await resolveAlias('local-draft-room');
        
        const rooms = await listRooms();
        const publishedRoom = rooms.find(r => r.roomId === 'server-published-abc123');
        
        return {
          success: true,
          resolvedToServerId: resolvedId === 'server-published-abc123',
          hasPublishedRoom: !!publishedRoom,
          publishedRoomTitle: publishedRoom?.title,
          roomCount: rooms.length
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.resolvedToServerId).toBe(true);
    expect(result.hasPublishedRoom).toBe(true);
    expect(result.publishedRoomTitle).toBe('Published Room Title');
  });

  test('Room expiry handling and metadata', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, listRooms } = window.avloPhase9;
      
      try {
        const now = new Date();
        const futureExpiry = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days
        const pastExpiry = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
        
        // Room with future expiry
        await upsertVisit('room-future-expiry', {
          title: 'Future Expiry Room',
          expires_at: futureExpiry.toISOString()
        });
        
        // Room with past expiry (should still be stored)
        await upsertVisit('room-past-expiry', {
          title: 'Past Expiry Room',
          expires_at: pastExpiry.toISOString()
        });
        
        // Room without expiry
        await upsertVisit('room-no-expiry', {
          title: 'No Expiry Room'
        });
        
        const rooms = await listRooms();
        const futureRoom = rooms.find(r => r.roomId === 'room-future-expiry');
        const pastRoom = rooms.find(r => r.roomId === 'room-past-expiry');
        const noExpiryRoom = rooms.find(r => r.roomId === 'room-no-expiry');
        
        return {
          success: true,
          totalRooms: rooms.length,
          futureRoomHasExpiry: !!futureRoom?.expires_at,
          pastRoomHasExpiry: !!pastRoom?.expires_at,
          noExpiryRoomHasExpiry: !!noExpiryRoom?.expires_at,
          allRoomsHaveTimestamps: rooms.every(r => r.last_opened)
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.totalRooms).toBe(3);
    expect(result.futureRoomHasExpiry).toBe(true);
    expect(result.pastRoomHasExpiry).toBe(true);
    expect(result.noExpiryRoomHasExpiry).toBe(false);
    expect(result.allRoomsHaveTimestamps).toBe(true);
  });

  test('Room removal operations', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, listRooms, removeFromList, deleteLocalCopy } = window.avloPhase9;
      
      try {
        // Create test rooms
        await upsertVisit('room-to-remove', { title: 'Room To Remove' });
        await upsertVisit('room-to-delete', { title: 'Room To Delete' });
        await upsertVisit('room-to-keep', { title: 'Room To Keep' });
        
        let rooms = await listRooms();
        const initialCount = rooms.length;
        
        // Remove from list only
        await removeFromList('room-to-remove');
        
        rooms = await listRooms();
        const afterRemoveCount = rooms.length;
        
        // Delete local copy (with mock destroy function)
        let destroyCalled = false;
        await deleteLocalCopy('room-to-delete', async () => {
          destroyCalled = true;
          // Mock implementation - in real usage this would clear y-indexeddb
        });
        
        rooms = await listRooms();
        const finalCount = rooms.length;
        
        return {
          success: true,
          initialCount,
          afterRemoveCount,
          finalCount,
          destroyCalled,
          removedRoomGone: !rooms.some(r => r.roomId === 'room-to-remove'),
          keptRoomStillThere: rooms.some(r => r.roomId === 'room-to-keep')
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.initialCount).toBe(3);
    expect(result.afterRemoveCount).toBe(2);
    expect(result.destroyCalled).toBe(true);
    expect(result.removedRoomGone).toBe(true);
    expect(result.keptRoomStillThere).toBe(true);
  });

  test('Complex alias resolution scenarios', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { setAlias, resolveAlias } = window.avloPhase9;
      
      try {
        // Set up various alias scenarios
        await setAlias('local-room-1', 'server-room-1');
        await setAlias('local-room-2', 'server-room-2');
        
        // Test resolutions
        const resolved1 = await resolveAlias('local-room-1');
        const resolved2 = await resolveAlias('local-room-2');
        const resolvedUnmapped = await resolveAlias('local-room-3');
        const resolvedRegular = await resolveAlias('regular-room-id');
        const resolvedServer = await resolveAlias('server-room-1');
        
        // Test invalid alias attempts (should be handled gracefully)
        await setAlias('regular-room', 'server-room'); // Should not set (no local- prefix)
        const shouldNotResolve = await resolveAlias('regular-room');
        
        return {
          success: true,
          resolved1: resolved1,
          resolved2: resolved2,
          resolvedUnmapped: resolvedUnmapped,
          resolvedRegular: resolvedRegular,
          resolvedServer: resolvedServer,
          shouldNotResolve: shouldNotResolve,
          mappingWorks: resolved1 === 'server-room-1' && resolved2 === 'server-room-2',
          unmappedPassthrough: resolvedUnmapped === 'local-room-3',
          regularPassthrough: resolvedRegular === 'regular-room-id',
          serverPassthrough: resolvedServer === 'server-room-1'
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.mappingWorks).toBe(true);
    expect(result.unmappedPassthrough).toBe(true);
    expect(result.regularPassthrough).toBe(true);
    expect(result.serverPassthrough).toBe(true);
    expect(result.shouldNotResolve).toBe('regular-room'); // Should pass through unchanged
  });

  test('Data integrity across multiple operations', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, handlePublish, listRooms, resolveAlias } = window.avloPhase9;
      
      try {
        // Complex workflow simulation
        // 1. Create a provisional room
        await upsertVisit('local-draft-1', {
          title: 'Draft 1',
          provisional: true
        });
        
        // 2. Visit it again (should update metadata)
        await upsertVisit('local-draft-1', {
          title: 'Draft 1 Updated'
        });
        
        // 3. Create another room
        await upsertVisit('regular-room-1', {
          title: 'Regular Room 1'
        });
        
        // 4. Publish the draft
        await handlePublish('local-draft-1', 'server-abc123', 'Published Draft');
        
        // 5. Visit the published room using the local alias
        await upsertVisit('local-draft-1', {
          title: 'Published Draft Updated'
        });
        
        const rooms = await listRooms();
        const resolvedAlias = await resolveAlias('local-draft-1');
        const publishedRoom = rooms.find(r => r.roomId === 'server-abc123');
        
        return {
          success: true,
          totalRooms: rooms.length,
          aliasResolves: resolvedAlias === 'server-abc123',
          publishedRoomExists: !!publishedRoom,
          publishedRoomTitle: publishedRoom?.title,
          hasRegularRoom: rooms.some(r => r.roomId === 'regular-room-1')
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.aliasResolves).toBe(true);
    expect(result.publishedRoomExists).toBe(true);
    expect(result.publishedRoomTitle).toBe('Published Draft Updated');
    expect(result.hasRegularRoom).toBe(true);
  });

  test('Concurrent operations and race conditions', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, listRooms } = window.avloPhase9;
      
      try {
        // Simulate concurrent room visits
        const concurrentPromises = [];
        
        for (let i = 0; i < 10; i++) {
          concurrentPromises.push(
            upsertVisit(`concurrent-room-${i}`, {
              title: `Concurrent Room ${i}`
            })
          );
        }
        
        // Wait for all operations to complete
        await Promise.all(concurrentPromises);
        
        const rooms = await listRooms();
        const concurrentRooms = rooms.filter(r => r.roomId.startsWith('concurrent-room-'));
        
        return {
          success: true,
          expectedCount: 10,
          actualCount: concurrentRooms.length,
          allRoomsHaveValidData: concurrentRooms.every(r => r.title && r.last_opened),
          roomIds: concurrentRooms.map(r => r.roomId).sort()
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.actualCount).toBe(10);
    expect(result.allRoomsHaveValidData).toBe(true);
    
    // Verify all expected room IDs are present
    const expectedIds = Array.from({ length: 10 }, (_, i) => `concurrent-room-${i}`);
    expect(result.roomIds).toEqual(expectedIds);
  });

  test('Edge cases and error handling', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { upsertVisit, setAlias, resolveAlias, handlePublish } = window.avloPhase9;
      
      try {
        const results = {};
        
        // Test empty/null values handling
        try {
          await upsertVisit('', { title: 'Empty ID Room' });
          results.emptyIdHandled = true;
        } catch (e) {
          results.emptyIdError = e.message;
        }
        
        // Test very long room ID
        const longId = 'room-' + 'a'.repeat(1000);
        await upsertVisit(longId, { title: 'Long ID Room' });
        results.longIdWorked = true;
        
        // Test special characters in room ID
        await upsertVisit('room-with-special-chars-!@#$%^&*()', { title: 'Special Chars Room' });
        results.specialCharsWorked = true;
        
        // Test very long title
        const longTitle = 'Very Long Title ' + 'x'.repeat(1000);
        await upsertVisit('room-long-title', { title: longTitle });
        results.longTitleWorked = true;
        
        // Test alias edge cases
        await setAlias('local-test', 'local-test'); // Self-mapping (should be handled gracefully)
        const selfMapped = await resolveAlias('local-test');
        results.selfMappingHandled = selfMapped === 'local-test';
        
        // Test publishing with same IDs
        try {
          await handlePublish('same-id', 'same-id', 'Same ID Test');
          results.sameIdPublishHandled = true;
        } catch (e) {
          results.sameIdPublishError = e.message;
        }
        
        return {
          success: true,
          ...results
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.longIdWorked).toBe(true);
    expect(result.specialCharsWorked).toBe(true);
    expect(result.longTitleWorked).toBe(true);
    expect(result.selfMappingHandled).toBe(true);
  });
});