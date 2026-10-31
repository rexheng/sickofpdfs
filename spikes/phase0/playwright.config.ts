import { defineConfig } from '@playwright/test';

// Each test launches its own persistent Chromium with the built extension (tests/fixtures.ts),
// so the browser is not configured here. One worker: the checks measure timings.
export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: 'results/test-output',
  use: { viewport: { width: 1280, height: 800 } },
});
