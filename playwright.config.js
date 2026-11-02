import { defineConfig, devices } from '@playwright/test';
import { PORT } from './e2e/env.js';

// Browser tests drive the real UI against generated fixture saves (see e2e/serve.js).
// They share one server and one save folder, so they run one at a time.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } }],
  webServer: {
    command: 'node e2e/serve.js',
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
