import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  use: { 
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000', 
    headless: true 
  },
  webServer: {
    command: 'npm run e2e:serve',
    url: process.env.BASE_URL ?? 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  projects: [{ name: 'chromium' }]
});