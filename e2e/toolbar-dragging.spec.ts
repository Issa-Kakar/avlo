import { test, expect, Page } from '@playwright/test';

test.describe('Toolbar Dragging', () => {
  let page: Page;

  test.beforeEach(async ({ page: testPage }) => {
    page = testPage;
    // Navigate to the room page
    await page.goto('/room/test-room');

    // Wait for the toolbar to be visible
    await page.waitForSelector('.tool-panel', { timeout: 10000 });
  });

  test('toolbar should follow cursor during drag', async () => {
    // Get the toolbar and drag handle
    const toolbar = page.locator('.tool-panel');
    const dragHandle = page.locator('.drag-handle');

    // Get initial position
    const initialBox = await toolbar.boundingBox();
    expect(initialBox).toBeTruthy();

    console.log('Initial toolbar position:', initialBox);

    // Start dragging from the center of the drag handle
    const dragHandleBox = await dragHandle.boundingBox();
    expect(dragHandleBox).toBeTruthy();

    const startX = dragHandleBox!.x + dragHandleBox!.width / 2;
    const startY = dragHandleBox!.y + dragHandleBox!.height / 2;

    console.log('Starting drag from:', { x: startX, y: startY });

    // Perform drag operation - move 100px right and 50px down
    const deltaX = 100;
    const deltaY = 50;
    const endX = startX + deltaX;
    const endY = startY + deltaY;

    // Start the drag
    await page.mouse.move(startX, startY);
    await page.mouse.down();

    // Move in small steps to simulate real drag
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const currentX = startX + (deltaX * i) / steps;
      const currentY = startY + (deltaY * i) / steps;
      await page.mouse.move(currentX, currentY);
      await page.waitForTimeout(10); // Small delay
    }

    // End the drag
    await page.mouse.up();

    // Wait for any animations to complete
    await page.waitForTimeout(100);

    // Get final position
    const finalBox = await toolbar.boundingBox();
    expect(finalBox).toBeTruthy();

    console.log('Final toolbar position:', finalBox);

    // Calculate expected position change
    // The toolbar position should change by approximately the same amount as the drag
    const actualDeltaX = finalBox!.x - initialBox!.x;
    const actualDeltaY = finalBox!.y - initialBox!.y;

    console.log('Expected delta:', { x: deltaX, y: deltaY });
    console.log('Actual delta:', { x: actualDeltaX, y: actualDeltaY });

    // Allow for some tolerance due to constraints and rounding
    const tolerance = 10;

    expect(Math.abs(actualDeltaX - deltaX)).toBeLessThan(tolerance);
    expect(Math.abs(actualDeltaY - deltaY)).toBeLessThan(tolerance);
  });

  test('toolbar should stay within canvas bounds', async () => {
    const toolbar = page.locator('.tool-panel');
    const canvasContainer = page.locator('.canvas-container');

    // Get container bounds
    const containerBox = await canvasContainer.boundingBox();
    expect(containerBox).toBeTruthy();

    // Try to drag toolbar to extreme positions
    const dragHandle = page.locator('.drag-handle');
    const dragHandleBox = await dragHandle.boundingBox();
    expect(dragHandleBox).toBeTruthy();

    const startX = dragHandleBox!.x + dragHandleBox!.width / 2;
    const startY = dragHandleBox!.y + dragHandleBox!.height / 2;

    // Test dragging to top-left corner (should be constrained by margin)
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(0, 0); // Try to drag to top-left
    await page.mouse.up();
    await page.waitForTimeout(100);

    let finalBox = await toolbar.boundingBox();
    expect(finalBox).toBeTruthy();

    // Should be at least 20px (margin) from the edges
    expect(finalBox!.x).toBeGreaterThanOrEqual(containerBox!.x + 20);
    expect(finalBox!.y).toBeGreaterThanOrEqual(containerBox!.y + 20);

    // Test dragging to bottom-right corner
    await page.mouse.move(finalBox!.x + finalBox!.width / 2, finalBox!.y + finalBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      containerBox!.x + containerBox!.width,
      containerBox!.y + containerBox!.height,
    );
    await page.mouse.up();
    await page.waitForTimeout(100);

    finalBox = await toolbar.boundingBox();
    expect(finalBox).toBeTruthy();

    // Should be at least 20px from the right and bottom edges
    expect(finalBox!.x + finalBox!.width).toBeLessThanOrEqual(
      containerBox!.x + containerBox!.width - 20,
    );
    expect(finalBox!.y + finalBox!.height).toBeLessThanOrEqual(
      containerBox!.y + containerBox!.height - 20,
    );
  });

  test('toolbar position should be persisted', async () => {
    const toolbar = page.locator('.tool-panel');
    const dragHandle = page.locator('.drag-handle');

    // Get initial position
    const initialBox = await toolbar.boundingBox();
    expect(initialBox).toBeTruthy();

    // Drag to new position
    const dragHandleBox = await dragHandle.boundingBox();
    expect(dragHandleBox).toBeTruthy();

    const startX = dragHandleBox!.x + dragHandleBox!.width / 2;
    const startY = dragHandleBox!.y + dragHandleBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 150, startY + 80);
    await page.mouse.up();
    await page.waitForTimeout(100);

    // Get new position
    const newBox = await toolbar.boundingBox();
    expect(newBox).toBeTruthy();

    // Refresh the page
    await page.reload();
    await page.waitForSelector('.tool-panel', { timeout: 10000 });

    // Check that position is restored
    const restoredBox = await toolbar.boundingBox();
    expect(restoredBox).toBeTruthy();

    // Position should be close to where we dragged it (within 5px tolerance)
    expect(Math.abs(restoredBox!.x - newBox!.x)).toBeLessThan(5);
    expect(Math.abs(restoredBox!.y - newBox!.y)).toBeLessThan(5);
  });
});
