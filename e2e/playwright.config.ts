import { defineConfig } from '@playwright/test';

// Each test launches its own persistent Chromium with the test build (support/test.ts), so no browser is configured here.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
  outputDir: '../test-results',
  use: { viewport: { width: 1280, height: 800 } },
});
