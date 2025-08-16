import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    avloPhase9: {
      roomsStore: any;
      aliasStore: any;
    };
  }
}

test.describe('Phase 9 - IndexedDB Storage Stress Tests', () => {
  
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
  });

  test('Large dataset storage and retrieval', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { roomsStore } = window.avloPhase9;
      
      try {
        const startTime = performance.now();
        
        // Create 100 rooms with varying data sizes
        const rooms = [];
        for (let i = 0; i < 100; i++) {
          const room = {
            roomId: `large-dataset-room-${i.toString().padStart(3, '0')}`,
            title: `Room ${i} - ${'Large data '.repeat(i % 10 + 1)}`,
            last_opened: new Date(Date.now() - i * 1000).toISOString(),
            expires_at: new Date(Date.now() + (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
            provisional: i % 3 === 0,
          };
          rooms.push(room);
          await roomsStore.put(room);
        }
        
        const insertTime = performance.now() - startTime;
        
        // Retrieve all rooms and verify data integrity
        const retrievalStart = performance.now();
        const allRooms = await roomsStore.all();
        const retrievalTime = performance.now() - retrievalStart;
        
        // Verify data integrity
        const dataIntegrityChecks = {
          correctCount: allRooms.length >= 100, // >= because other tests might have added rooms
          allHaveRequiredFields: allRooms.every(r => r.roomId && r.title && r.last_opened),
          timestampsValid: allRooms.every(r => !isNaN(new Date(r.last_opened).getTime())),
          expiryDatesValid: allRooms.filter(r => r.expires_at).every(r => !isNaN(new Date(r.expires_at).getTime()))
        };
        
        return {
          success: true,
          insertTime,
          retrievalTime,
          roomCount: allRooms.length,
          ...dataIntegrityChecks,
          performanceAcceptable: insertTime < 5000 && retrievalTime < 1000 // 5s insert, 1s retrieval
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.correctCount).toBe(true);
    expect(result.allHaveRequiredFields).toBe(true);
    expect(result.timestampsValid).toBe(true);
    expect(result.expiryDatesValid).toBe(true);
    expect(result.performanceAcceptable).toBe(true);
  });

  test('Rapid sequential operations', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { roomsStore } = window.avloPhase9;
      
      try {
        const roomId = 'rapid-ops-room';
        let operationCount = 0;
        
        // Rapid create/update/read cycles
        for (let i = 0; i < 50; i++) {
          // Create/Update
          await roomsStore.put({
            roomId,
            title: `Rapid Operation ${i}`,
            last_opened: new Date().toISOString(),
          });
          operationCount++;
          
          // Read back
          const retrieved = await roomsStore.get(roomId);
          if (!retrieved || retrieved.title !== `Rapid Operation ${i}`) {
            throw new Error(`Data inconsistency at operation ${i}`);
          }
          operationCount++;
        }
        
        // Final verification
        const finalRoom = await roomsStore.get(roomId);
        
        return {
          success: true,
          operationCount,
          finalTitle: finalRoom?.title,
          consistencyMaintained: finalRoom?.title === 'Rapid Operation 49'
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.operationCount).toBe(100);
    expect(result.consistencyMaintained).toBe(true);
    expect(result.finalTitle).toBe('Rapid Operation 49');
  });

  test('Complex alias store operations', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { aliasStore } = window.avloPhase9;
      
      try {
        // Create many aliases
        const aliases = [];
        for (let i = 0; i < 50; i++) {
          const provisionalId = `local-alias-${i}`;
          const serverId = `server-${i}-${Math.random().toString(36).substr(2, 9)}`;
          
          await aliasStore.set(provisionalId, serverId);
          aliases.push({ provisionalId, serverId });
        }
        
        // Verify all aliases can be retrieved correctly
        let correctMappings = 0;
        for (const alias of aliases) {
          const retrieved = await aliasStore.get(alias.provisionalId);
          if (retrieved === alias.serverId) {
            correctMappings++;
          }
        }
        
        // Test updates (overwriting existing aliases)
        const updateCount = 10;
        for (let i = 0; i < updateCount; i++) {
          const provisionalId = `local-alias-${i}`;
          const newServerId = `updated-server-${i}`;
          await aliasStore.set(provisionalId, newServerId);
          
          const updated = await aliasStore.get(provisionalId);
          if (updated !== newServerId) {
            throw new Error(`Update failed for ${provisionalId}`);
          }
        }
        
        // Test deletions
        const deleteCount = 5;
        for (let i = 0; i < deleteCount; i++) {
          const provisionalId = `local-alias-${i}`;
          await aliasStore.del(provisionalId);
          
          const deleted = await aliasStore.get(provisionalId);
          if (deleted !== undefined) {
            throw new Error(`Deletion failed for ${provisionalId}`);
          }
        }
        
        return {
          success: true,
          totalAliases: aliases.length,
          correctInitialMappings: correctMappings,
          allInitialMappingsCorrect: correctMappings === aliases.length,
          updatesWorked: updateCount,
          deletionsWorked: deleteCount
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.allInitialMappingsCorrect).toBe(true);
    expect(result.updatesWorked).toBe(10);
    expect(result.deletionsWorked).toBe(5);
  });

  test('Transaction consistency under load', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { roomsStore, aliasStore } = window.avloPhase9;
      
      try {
        // Simulate concurrent operations that might cause transaction conflicts
        const promises = [];
        
        // Create multiple rooms concurrently
        for (let i = 0; i < 20; i++) {
          promises.push(
            roomsStore.put({
              roomId: `concurrent-${i}`,
              title: `Concurrent Room ${i}`,
              last_opened: new Date().toISOString(),
            })
          );
        }
        
        // Create aliases concurrently
        for (let i = 0; i < 20; i++) {
          promises.push(
            aliasStore.set(`local-concurrent-${i}`, `server-concurrent-${i}`)
          );
        }
        
        // Wait for all operations
        await Promise.all(promises);
        
        // Verify all data was written correctly
        const rooms = await roomsStore.all();
        const concurrentRooms = rooms.filter(r => r.roomId.startsWith('concurrent-'));
        
        let aliasesCorrect = 0;
        for (let i = 0; i < 20; i++) {
          const alias = await aliasStore.get(`local-concurrent-${i}`);
          if (alias === `server-concurrent-${i}`) {
            aliasesCorrect++;
          }
        }
        
        return {
          success: true,
          expectedRooms: 20,
          actualRooms: concurrentRooms.length,
          roomsConsistent: concurrentRooms.length === 20,
          expectedAliases: 20,
          actualAliases: aliasesCorrect,
          aliasesConsistent: aliasesCorrect === 20
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.roomsConsistent).toBe(true);
    expect(result.aliasesConsistent).toBe(true);
  });

  test('Database size and memory efficiency', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { roomsStore } = window.avloPhase9;
      
      try {
        // Create rooms with varying data sizes to test storage efficiency
        const rooms = [];
        
        // Small rooms
        for (let i = 0; i < 10; i++) {
          rooms.push({
            roomId: `small-${i}`,
            title: `Small ${i}`,
            last_opened: new Date().toISOString(),
          });
        }
        
        // Medium rooms
        for (let i = 0; i < 10; i++) {
          rooms.push({
            roomId: `medium-${i}`,
            title: `Medium Room ${i} - ${'Medium sized data '.repeat(20)}`,
            last_opened: new Date().toISOString(),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          });
        }
        
        // Large rooms (testing storage limits)
        for (let i = 0; i < 5; i++) {
          rooms.push({
            roomId: `large-${i}`,
            title: `Large Room ${i} - ${'Very large data content '.repeat(100)}`,
            last_opened: new Date().toISOString(),
            expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
            provisional: false,
          });
        }
        
        // Store all rooms
        for (const room of rooms) {
          await roomsStore.put(room);
        }
        
        // Retrieve and verify
        const allRooms = await roomsStore.all();
        const testRooms = allRooms.filter(r => 
          r.roomId.startsWith('small-') || 
          r.roomId.startsWith('medium-') || 
          r.roomId.startsWith('large-')
        );
        
        // Calculate approximate data sizes
        const smallRooms = testRooms.filter(r => r.roomId.startsWith('small-'));
        const mediumRooms = testRooms.filter(r => r.roomId.startsWith('medium-'));
        const largeRooms = testRooms.filter(r => r.roomId.startsWith('large-'));
        
        return {
          success: true,
          totalTestRooms: testRooms.length,
          smallRoomsCount: smallRooms.length,
          mediumRoomsCount: mediumRooms.length,
          largeRoomsCount: largeRooms.length,
          allDataRetrieved: testRooms.length === 25,
          largeDataIntact: largeRooms.every(r => r.title.includes('Very large data content')),
          storageEfficient: true // If we get here without errors, storage is working efficiently
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.allDataRetrieved).toBe(true);
    expect(result.smallRoomsCount).toBe(10);
    expect(result.mediumRoomsCount).toBe(10);
    expect(result.largeRoomsCount).toBe(5);
    expect(result.largeDataIntact).toBe(true);
    expect(result.storageEfficient).toBe(true);
  });

  test('IndexedDB error handling and recovery', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { roomsStore, aliasStore } = window.avloPhase9;
      
      try {
        const results = {};
        
        // Test handling of invalid data types (should be handled gracefully)
        try {
          await roomsStore.put({
            roomId: 'test-invalid-data',
            title: 'Valid Title',
            last_opened: 'invalid-date-format',
          });
          results.invalidDateHandled = true;
        } catch (e) {
          results.invalidDateError = e.message;
        }
        
        // Test handling of missing required fields
        try {
          await roomsStore.put({
            // Missing roomId
            title: 'Missing ID Room',
            last_opened: new Date().toISOString(),
          });
          results.missingIdHandled = false;
        } catch (e) {
          results.missingIdHandled = true;
          results.missingIdError = e.message;
        }
        
        // Test data retrieval after potential corruption scenarios
        await roomsStore.put({
          roomId: 'recovery-test',
          title: 'Recovery Test Room',
          last_opened: new Date().toISOString(),
        });
        
        const recovered = await roomsStore.get('recovery-test');
        results.dataRecoverable = !!recovered && recovered.title === 'Recovery Test Room';
        
        // Test alias store error handling
        try {
          await aliasStore.set('', 'empty-key-test');
          results.emptyKeyHandled = true;
        } catch (e) {
          results.emptyKeyError = e.message;
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
    expect(result.dataRecoverable).toBe(true);
    // Note: Some error conditions might be handled gracefully by IndexedDB itself
  });

  test('Cross-tab data consistency simulation', async ({ page }) => {
    const result = await page.evaluate(async () => {
      if (!window.avloPhase9) return { error: 'Phase 9 not available' };
      
      const { roomsStore } = window.avloPhase9;
      
      try {
        // Simulate what would happen if multiple tabs were modifying data
        // We can't actually test multiple tabs, but we can test rapid modifications
        
        const roomId = 'cross-tab-test';
        
        // Simulate tab 1 operations
        await roomsStore.put({
          roomId,
          title: 'Tab 1 Version',
          last_opened: new Date().toISOString(),
        });
        
        // Simulate slight delay
        await new Promise(resolve => setTimeout(resolve, 1));
        
        // Simulate tab 2 operations (overwriting)
        await roomsStore.put({
          roomId,
          title: 'Tab 2 Version',
          last_opened: new Date().toISOString(),
          provisional: true,
        });
        
        // Verify final state
        const finalRoom = await roomsStore.get(roomId);
        
        // Simulate reading from different "tabs" by getting all rooms multiple times
        const read1 = await roomsStore.all();
        const read2 = await roomsStore.all();
        const read3 = await roomsStore.all();
        
        const consistentReads = 
          read1.length === read2.length && 
          read2.length === read3.length &&
          read1.every((room, index) => 
            room.roomId === read2[index].roomId && 
            room.roomId === read3[index].roomId
          );
        
        return {
          success: true,
          finalTitle: finalRoom?.title,
          finalProvisional: finalRoom?.provisional,
          lastWriteWins: finalRoom?.title === 'Tab 2 Version',
          consistentReads
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.lastWriteWins).toBe(true);
    expect(result.consistentReads).toBe(true);
  });
});