import { test, expect } from '@playwright/test';

test.describe('Metadata API', () => {
  test('should return 404 when Redis doc is missing', async ({ request }) => {
    // Try to get metadata for a non-existent room
    const response = await request.get('/api/rooms/non-existent-room/metadata');
    expect(response.status()).toBe(404);
  });

  test('should return 200 with room metadata after successful writes', async ({ page, request }) => {
    // Create a new room
    const createResponse = await request.post('/api/rooms', {
      data: {
        title: 'Test Room for Metadata'
      }
    });
    
    expect(createResponse.ok()).toBeTruthy();
    const { roomId } = await createResponse.json();
    
    // Navigate to the room to ensure it exists
    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Wait a bit for the room to be persisted
    await page.waitForTimeout(3000);
    
    // Get metadata
    const metadataResponse = await request.get(`/api/rooms/${roomId}/metadata`);
    expect(metadataResponse.status()).toBe(200);
    
    const metadata = await metadataResponse.json();
    expect(metadata).toHaveProperty('title');
    expect(metadata).toHaveProperty('size_bytes');
    expect(metadata).toHaveProperty('expires_at');
    expect(metadata).toHaveProperty('created_at');
    
    // size_bytes should be a number >= 0
    expect(typeof metadata.size_bytes).toBe('number');
    expect(metadata.size_bytes).toBeGreaterThanOrEqual(0);
  });

  test('should update title with PUT request', async ({ page, request }) => {
    // Create a room first
    const createResponse = await request.post('/api/rooms', {
      data: {
        title: 'Original Title'
      }
    });
    
    const { roomId } = await createResponse.json();
    
    // Navigate to ensure room exists
    await page.goto(`/rooms/${roomId}`);
    await expect(page.getByTestId('connection-chip')).toContainText('Online', { timeout: 10000 });
    
    // Update the title
    const updateResponse = await request.put(`/api/rooms/${roomId}`, {
      data: {
        title: 'Updated Title'
      }
    });
    
    expect(updateResponse.status()).toBe(200);
    
    // Verify the title was updated
    const metadataResponse = await request.get(`/api/rooms/${roomId}/metadata`);
    const metadata = await metadataResponse.json();
    expect(metadata.title).toBe('Updated Title');
  });

  test('should enforce rate limiting on room creation', async ({ request }) => {
    const requests = [];
    
    // Make 11 requests rapidly (assuming limit is 10/hour)
    for (let i = 0; i < 11; i++) {
      requests.push(
        request.post('/api/rooms', {
          data: { title: `Room ${i}` }
        })
      );
    }
    
    const responses = await Promise.all(requests);
    
    // At least one should be rate limited
    const rateLimited = responses.some(r => r.status() === 429);
    expect(rateLimited).toBeTruthy();
  });
});