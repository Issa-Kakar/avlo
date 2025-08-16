import { test, expect } from '@playwright/test';

test.describe('Entry Flow - Create and Join Boards', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('Create Board - with name', async ({ page }) => {
    // Click Create Room button
    await page.getByRole('button', { name: 'Create Room' }).first().click();

    // Dialog should be visible
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Create a new board' })).toBeVisible();

    // Enter board name
    await page.getByLabel('Board name (optional)').fill('Team Sync');

    // Click Create button
    await page.getByRole('button', { name: 'Create' }).click();

    // Should navigate to room and show success toast
    await expect(page).toHaveURL(/\/rooms\/.+/);
    await expect(page.getByText('Board created. Link copied.')).toBeVisible();
  });

  test('Create Board - skip and create (fast path)', async ({ page }) => {
    // Click Create Room button
    await page.getByRole('button', { name: 'Create Room' }).first().click();

    // Click Skip & create
    await page.getByRole('button', { name: 'Skip & create' }).click();

    // Should navigate to room with default name
    await expect(page).toHaveURL(/\/rooms\/.+/);
    await expect(page.getByText('Board created. Link copied.')).toBeVisible();
  });

  test('Join Board - with valid URL', async ({ page, context }) => {
    // First create a room to join
    const createPage = await context.newPage();
    await createPage.goto('/');
    await createPage.getByRole('button', { name: 'Create Room' }).first().click();
    await createPage.getByRole('button', { name: 'Skip & create' }).click();
    await createPage.waitForURL(/\/rooms\/.+/);
    const roomUrl = createPage.url();
    const roomId = roomUrl.split('/rooms/')[1];

    // Now try to join it from another page
    await page.getByRole('button', { name: 'Join Room' }).first().click();

    // Dialog should be visible
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Join a board' })).toBeVisible();

    // Paste the full URL
    await page.getByLabel('Paste a link, enter a board ID, or a 6-character code').fill(roomUrl);

    // Should show parsed hint
    await expect(page.getByText(`ID: ${roomId.slice(-6)}`)).toBeVisible();

    // Click Join
    await page.getByRole('button', { name: 'Join' }).click();

    // Should navigate to the same room
    await expect(page).toHaveURL(roomUrl);

    await createPage.close();
  });

  test('Join Board - with room ID', async ({ page, context }) => {
    // First create a room
    const createPage = await context.newPage();
    await createPage.goto('/');
    await createPage.getByRole('button', { name: 'Create Room' }).first().click();
    await createPage.getByRole('button', { name: 'Skip & create' }).click();
    await createPage.waitForURL(/\/rooms\/.+/);
    const roomId = createPage.url().split('/rooms/')[1];

    // Join with ID
    await page.getByRole('button', { name: 'Join Room' }).first().click();
    await page.getByLabel('Paste a link, enter a board ID, or a 6-character code').fill(roomId);

    // Should show ID detected hint
    await expect(page.getByText('Board ID detected')).toBeVisible();

    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page).toHaveURL(/\/rooms\/.+/);

    await createPage.close();
  });

  test('Join Board - invalid input shows error', async ({ page }) => {
    await page.getByRole('button', { name: 'Join Room' }).first().click();

    // Enter invalid input (looks like a name)
    await page
      .getByLabel('Paste a link, enter a board ID, or a 6-character code')
      .fill('My Brainstorm Session');

    await page.getByRole('button', { name: 'Join' }).click();

    // Should show error
    await expect(page.getByText("That doesn't look like a board link, ID, or code.")).toBeVisible();
  });

  test('Join Board - not found shows create option', async ({ page }) => {
    await page.getByRole('button', { name: 'Join Room' }).first().click();

    // Enter a valid-looking but non-existent ID
    await page
      .getByLabel('Paste a link, enter a board ID, or a 6-character code')
      .fill('01234567890123456789ABCD');

    await page.getByRole('button', { name: 'Join' }).click();

    // Wait for checking to complete
    await page.waitForTimeout(500);

    // Should show not found screen
    await expect(page.getByRole('heading', { name: 'Board not found' })).toBeVisible();
    await expect(page.getByText('No board matches what you entered.')).toBeVisible();

    // Should have options to create or try again
    await expect(page.getByRole('button', { name: 'Create a new board' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

    // Click Create a new board
    await page.getByRole('button', { name: 'Create a new board' }).click();

    // Should open Create dialog
    await expect(page.getByRole('heading', { name: 'Create a new board' })).toBeVisible();
  });

  test('Dialog keyboard navigation - Escape closes dialog', async ({ page }) => {
    // Open Create dialog
    await page.getByRole('button', { name: 'Create Room' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();

    // Press Escape
    await page.keyboard.press('Escape');

    // Dialog should be closed
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // Open Join dialog
    await page.getByRole('button', { name: 'Join Room' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();

    // Press Escape
    await page.keyboard.press('Escape');

    // Dialog should be closed
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('Dialog keyboard navigation - Enter submits form', async ({ page }) => {
    // Open Create dialog
    await page.getByRole('button', { name: 'Create Room' }).first().click();

    // Type name and press Enter
    await page.getByLabel('Board name (optional)').fill('Quick Test');
    await page.keyboard.press('Enter');

    // Should navigate to room
    await expect(page).toHaveURL(/\/rooms\/.+/);
  });

  test('Create Board - name validation', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Room' }).first().click();

    // Try to enter a name that's too long (>60 chars)
    const longName = 'A'.repeat(61);
    await page.getByLabel('Board name (optional)').fill(longName);

    // Input should enforce maxLength
    const inputValue = await page.getByLabel('Board name (optional)').inputValue();
    expect(inputValue.length).toBeLessThanOrEqual(60);
  });

  test('Join Board - share code not supported message', async ({ page }) => {
    await page.getByRole('button', { name: 'Join Room' }).first().click();

    // Enter a 6-character code
    await page.getByLabel('Paste a link, enter a board ID, or a 6-character code').fill('ABC123');

    // Should show share code detected hint
    await expect(page.getByText('Share code detected')).toBeVisible();

    await page.getByRole('button', { name: 'Join' }).click();

    // Should show not supported error (since we don't have server support yet)
    await expect(
      page.getByText('Share codes are not yet supported. Please use the full link or ID.'),
    ).toBeVisible();
  });

  test('Dialog focus management', async ({ page }) => {
    // Open Create dialog
    await page.getByRole('button', { name: 'Create Room' }).first().click();

    // Focus should be on the name input
    await expect(page.getByLabel('Board name (optional)')).toBeFocused();

    // Tab through elements
    await page.keyboard.press('Tab'); // Cancel button
    await page.keyboard.press('Tab'); // Skip & create button
    await page.keyboard.press('Tab'); // Create button
    await page.keyboard.press('Tab'); // Should wrap back to input

    await expect(page.getByLabel('Board name (optional)')).toBeFocused();
  });

  test('Recent rooms interaction', async ({ page }) => {
    // Check that recent rooms section exists
    await expect(page.getByRole('heading', { name: 'Recent on this device' })).toBeVisible();

    // Initially should show no rooms message
    await expect(
      page.getByText("No recent rooms yet. Create or join a room and it'll appear here."),
    ).toBeVisible();
  });
});
