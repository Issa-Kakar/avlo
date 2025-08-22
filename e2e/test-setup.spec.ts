/**
 * Simple test to verify Playwright and test harness setup
 */

import { test, expect } from '@playwright/test';

test('test harness loads correctly', async ({ page }) => {
  // Navigate to test harness
  await page.goto('/test-harness.html');
  
  // Wait for status to change from "Loading..." to either "Ready" or "Error"
  await page.waitForFunction(
    () => {
      const status = document.getElementById('status')?.textContent;
      return status && status !== 'Loading...';
    },
    { timeout: 10000 }
  );
  
  const status = await page.locator('#status').textContent();
  console.log('Test harness status:', status);
  
  // Check if there are any errors
  const errors = await page.locator('#errors').textContent();
  if (errors) {
    console.error('Test harness errors:', errors);
  }
  
  // Verify the harness loaded successfully
  expect(status).toBe('Ready');
});