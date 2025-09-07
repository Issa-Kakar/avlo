import { test, expect } from '@playwright/test';

test('debug toolbar dragging', async ({ page }) => {
  // Navigate to the room page
  await page.goto('/room/test-room');

  // Wait for the toolbar to be visible
  await page.waitForSelector('.tool-panel', { timeout: 10000 });

  // Get container and toolbar dimensions
  const canvasContainer = page.locator('.canvas-container');
  const toolbar = page.locator('.tool-panel');

  const containerBox = await canvasContainer.boundingBox();
  const toolbarBox = await toolbar.boundingBox();

  console.log('Canvas container dimensions:', containerBox);
  console.log('Toolbar dimensions:', toolbarBox);

  // Check computed styles
  const containerStyles = await page.evaluate(() => {
    const container = document.querySelector('.canvas-container') as HTMLElement;
    const toolbar = document.querySelector('.tool-panel') as HTMLElement;
    return {
      container: {
        width: container?.offsetWidth,
        height: container?.offsetHeight,
        clientWidth: container?.clientWidth,
        clientHeight: container?.clientHeight,
      },
      toolbar: {
        width: toolbar?.offsetWidth,
        height: toolbar?.offsetHeight,
        transform: toolbar?.style.transform,
        position: getComputedStyle(toolbar).position,
        top: getComputedStyle(toolbar).top,
        left: getComputedStyle(toolbar).left,
      },
    };
  });

  console.log('Computed styles:', containerStyles);

  // Check what the bounds calculation would return
  const boundsInfo = await page.evaluate(() => {
    const container = document.querySelector('.canvas-container') as HTMLElement;
    const node = document.querySelector('.tool-panel') as HTMLElement;
    if (!container || !node) return null;

    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();

    const margin = 20;

    return {
      containerRect: {
        x: containerRect.x,
        y: containerRect.y,
        width: containerRect.width,
        height: containerRect.height,
      },
      nodeRect: {
        x: nodeRect.x,
        y: nodeRect.y,
        width: nodeRect.width,
        height: nodeRect.height,
      },
      calculatedBounds: {
        minX: margin,
        minY: margin,
        maxX: containerRect.width - nodeRect.width - margin,
        maxY: containerRect.height - nodeRect.height - margin,
      },
    };
  });

  console.log('Bounds calculation:', boundsInfo);
});
