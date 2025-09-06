import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',

  // Phase 2 tests are focused on data layer, not parallelism yet
  fullyParallel: false,
  workers: process.env.CI ? 1 : 2,

  // Fail fast in CI, retry locally
  retries: process.env.CI ? 0 : 1,

  // Better reporting
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  // Timeout configuration for Phase 2 tests
  timeout: 30000, // 30s global timeout
  expect: {
    timeout: 5000, // 5s for assertions
  },

  use: {
    baseURL: 'http://localhost:3000',

    // Better tracing for debugging
    trace: process.env.CI ? 'retain-on-failure' : 'on-first-retry',
    screenshot: 'only-on-failure',
    video: process.env.CI ? 'retain-on-failure' : 'off',

    // Viewport for consistency
    viewport: { width: 1280, height: 720 },

    // Action timeout
    actionTimeout: 10000,

    // Navigation timeout for test harness
    navigationTimeout: 10000,
  },

  // Test match patterns
  testMatch: '**/*.spec.ts',

  // Global setup/teardown could go here when needed
  // globalSetup: './e2e/global-setup.ts',
  // globalTeardown: './e2e/global-teardown.ts',

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true, // Always reuse since you have dev servers running
    timeout: 30000,
    stdout: 'pipe',
    stderr: 'pipe',
  },

  // Projects for different test suites (future expansion)
  projects: [
    {
      name: 'phase2',
      testMatch: '**/*.spec.ts',
      // Could add specific settings per phase
    },
  ],
});
