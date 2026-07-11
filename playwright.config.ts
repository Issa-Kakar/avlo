import { defineConfig, devices } from '@playwright/test';

// Honors BASE_URL / VITE_PORT so the `avlo-parallel` worktree (VITE_PORT=5180)
// works by env, same as vite.config. The webServer auto-starts `pnpm dev:web`
// (vite :3000) — the dev bridge (window.__avlo) is present in dev mode only.
const PORT = Number(process.env.VITE_PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  reporter: process.env.CI ? 'list' : 'html',
  use: { baseURL: BASE_URL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev:web',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
