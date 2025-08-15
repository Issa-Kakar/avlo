import { test, expect } from '@playwright/test';

test('WebSocket connection should work', async ({ page }) => {
  // Listen for console messages
  page.on('console', msg => {
    if (msg.text().includes('WebSocket')) {
      console.log('Browser console:', msg.text());
    }
  });
  
  // Navigate to a room
  await page.goto('http://localhost:5173/rooms/test-ws-connection');
  
  // Wait for the page to load
  await page.waitForTimeout(2000);
  
  // Check that the connection chip exists
  const connectionChip = page.getByTestId('connection-chip');
  await expect(connectionChip).toBeVisible();
  
  // Get the connection status
  const status = await connectionChip.textContent();
  console.log('Connection status:', status);
  
  // It should eventually show "Online" (not "Reconnecting")
  await expect(connectionChip).toHaveText('Online', { timeout: 10000 });
});