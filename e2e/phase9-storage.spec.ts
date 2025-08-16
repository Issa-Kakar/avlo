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
    };
  }
}

test.describe('Phase 9 - My Rooms Storage Layer', () => {
  
  test('IndexedDB wrapper creates databases correctly', async ({ page }) => {
    // Navigate to a page to load the app
    await page.goto('/');
    
    // Wait a moment for the app to load and modules to be available
    await page.waitForTimeout(1000);
    
    // Test IndexedDB creation by evaluating in browser context
    const dbExists = await page.evaluate(async () => {
      // Check if Phase 9 exports are available
      if (typeof window.avloPhase9 === 'undefined') {
        return { error: 'Phase 9 exports not available' };
      }
      
      const { roomsStore, aliasStore } = window.avloPhase9;
      
      try {
        // Test that we can perform basic operations
        const testRoom = {
          roomId: 'test-room-1',
          title: 'Test Room',
          last_opened: new Date().toISOString(),
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        };
        
        // Put a test room
        await roomsStore.put(testRoom);
        
        // Get the room back
        const retrieved = await roomsStore.get('test-room-1');
        
        // Test alias store
        await aliasStore.set('local-test', 'server-test');
        const alias = await aliasStore.get('local-test');
        
        return {
          roomRetrieved: retrieved !== undefined,
          roomTitle: retrieved?.title,
          aliasWorks: alias === 'server-test'
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(dbExists.roomRetrieved).toBe(true);
    expect(dbExists.roomTitle).toBe('Test Room');
    expect(dbExists.aliasWorks).toBe(true);
  });
  
  test('CRUD operations work for rooms and aliases stores', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
    
    const crudResults = await page.evaluate(async () => {
      if (typeof window.avloPhase9 === 'undefined') {
        return { error: 'Phase 9 exports not available' };
      }
      
      const { roomsStore, aliasStore } = window.avloPhase9;
      
      try {
        // Test rooms CRUD
        const room1 = {
          roomId: 'crud-test-1',
          title: 'CRUD Test Room 1',
          last_opened: new Date().toISOString(),
        };
        
        const room2 = {
          roomId: 'crud-test-2', 
          title: 'CRUD Test Room 2',
          last_opened: new Date().toISOString(),
        };
        
        // Create
        await roomsStore.put(room1);
        await roomsStore.put(room2);
        
        // Read all
        const allRooms = await roomsStore.all();
        const hasRoom1 = allRooms.some(r => r.roomId === 'crud-test-1');
        const hasRoom2 = allRooms.some(r => r.roomId === 'crud-test-2');
        
        // Update
        await roomsStore.put({ ...room1, title: 'Updated Title' });
        const updated = await roomsStore.get('crud-test-1');
        
        // Delete
        await roomsStore.del('crud-test-2');
        const afterDelete = await roomsStore.all();
        const stillHasRoom2 = afterDelete.some(r => r.roomId === 'crud-test-2');
        
        // Test aliases CRUD
        await aliasStore.set('local-crud-1', 'server-crud-1');
        await aliasStore.set('local-crud-2', 'server-crud-2');
        
        const alias1 = await aliasStore.get('local-crud-1');
        const alias2 = await aliasStore.get('local-crud-2');
        
        await aliasStore.del('local-crud-2');
        const deletedAlias = await aliasStore.get('local-crud-2');
        
        return {
          roomsCreated: hasRoom1 && hasRoom2,
          roomUpdated: updated?.title === 'Updated Title',
          roomDeleted: !stillHasRoom2,
          aliasesWork: alias1 === 'server-crud-1' && alias2 === 'server-crud-2',
          aliasDeleted: deletedAlias === undefined
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(crudResults.roomsCreated).toBe(true);
    expect(crudResults.roomUpdated).toBe(true);
    expect(crudResults.roomDeleted).toBe(true);
    expect(crudResults.aliasesWork).toBe(true);
    expect(crudResults.aliasDeleted).toBe(true);
  });
  
  test('Alias resolution logic works correctly', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
    
    const aliasResults = await page.evaluate(async () => {
      if (typeof window.avloPhase9 === 'undefined') {
        return { error: 'Phase 9 exports not available' };
      }
      
      const { resolveAlias, setAlias } = window.avloPhase9;
      
      try {
        // Test regular ID passthrough
        const regularId = await resolveAlias('regular-room-id');
        
        // Test local ID without mapping
        const unmappedLocal = await resolveAlias('local-unmapped');
        
        // Test local ID with mapping
        await setAlias('local-mapped', 'server-mapped');
        const mappedLocal = await resolveAlias('local-mapped');
        
        // Test setAlias validation
        await setAlias('not-local', 'should-not-set'); // Should not set non-local
        await setAlias('local-same', 'local-same'); // Should not set if same
        
        return {
          regularPassthrough: regularId === 'regular-room-id',
          unmappedLocal: unmappedLocal === 'local-unmapped',
          mappedLocal: mappedLocal === 'server-mapped'
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(aliasResults.regularPassthrough).toBe(true);
    expect(aliasResults.unmappedLocal).toBe(true);
    expect(aliasResults.mappedLocal).toBe(true);
  });
  
  test('Store operations work with alias resolution', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
    
    const storeResults = await page.evaluate(async () => {
      if (typeof window.avloPhase9 === 'undefined') {
        return { error: 'Phase 9 exports not available' };
      }
      
      const { upsertVisit, handlePublish, listRooms } = window.avloPhase9;
      
      try {
        // Test upsertVisit
        await upsertVisit('test-visit', {
          title: 'Visit Test Room',
          provisional: false,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });
        
        // Test handlePublish
        await handlePublish('local-publish-test', 'server-publish-test', 'Published Room');
        
        // List rooms to verify
        const rooms = await listRooms();
        const hasVisitRoom = rooms.some(r => r.roomId === 'test-visit');
        const hasPublishedRoom = rooms.some(r => r.roomId === 'server-publish-test');
        
        return {
          visitWorked: hasVisitRoom,
          publishWorked: hasPublishedRoom,
          roomCount: rooms.length
        };
      } catch (error) {
        return { error: error.message };
      }
    });
    
    expect(storeResults.visitWorked).toBe(true);
    expect(storeResults.publishWorked).toBe(true);
    expect(storeResults.roomCount).toBeGreaterThan(0);
  });
  
  test('Data persists across browser reloads', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
    
    // Create test data
    await page.evaluate(async () => {
      if (typeof window.avloPhase9 === 'undefined') {
        throw new Error('Phase 9 exports not available');
      }
      
      const { roomsStore } = window.avloPhase9;
      await roomsStore.put({
        roomId: 'persist-test',
        title: 'Persistence Test Room',
        last_opened: new Date().toISOString(),
      });
    });
    
    // Reload the page
    await page.reload();
    
    // Check if data persists
    await page.waitForTimeout(1000);
    const dataExists = await page.evaluate(async () => {
      if (typeof window.avloPhase9 === 'undefined') {
        return false;
      }
      
      const { roomsStore } = window.avloPhase9;
      const room = await roomsStore.get('persist-test');
      return room !== undefined && room.title === 'Persistence Test Room';
    });
    
    expect(dataExists).toBe(true);
  });
});