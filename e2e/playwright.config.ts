import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// The "no lost text" walkthrough imports Task 22's e2e/support/drag-select.ts. Until that file exists the spec cannot load, so it
// is left out; it comes in by itself when the file is there. Delete this block when Task 22 has merged.
const needTask22 = existsSync(new URL('./support/drag-select.ts', import.meta.url)) ? [] : ['**/walkthroughs/no-lost-text.spec-blind.spec.ts'];

// Each test launches its own persistent Chromium with the test build (support/test.ts), so no browser is configured here.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  testIgnore: needTask22,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
  outputDir: '../test-results',
  use: { viewport: { width: 1280, height: 800 } },
});
