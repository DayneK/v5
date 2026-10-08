import { defineConfig, devices } from '@playwright/test';

// When VEPA_E2E_BASE_URL is set (managed Freebuff preview), Playwright runs
// against that already-running server and does not spawn its own dev server.
// Without it, the local dev-server fallback below is unchanged.
const EXTERNAL_BASE_URL = process.env.VEPA_E2E_BASE_URL || '';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // Generous: the managed preview is a remote host, so boot (launch modal +
  // first population) legitimately takes tens of seconds.
  timeout: 150_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: EXTERNAL_BASE_URL || 'http://127.0.0.1:4173/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: 'npm run dev -- --host 0.0.0.0 --port 4173',
        url: 'http://127.0.0.1:4173/',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
