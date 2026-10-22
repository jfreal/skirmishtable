import { defineConfig } from '@playwright/test';

// Browser smoke tests against the production build (`npm run test:e2e` builds first).
// First run: `npx playwright install chromium`. PW_CHROMIUM_PATH points at an existing
// Chromium instead (CI images, sandboxes).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,   // software-rendered WebGL (CI, sandboxes) draws the full-res models slowly
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: { command: 'npm run preview', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI },
});
