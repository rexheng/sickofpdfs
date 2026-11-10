import { defineConfig } from '@playwright/test';

// Records the launch video's footage (record.spec.ts). Each scene launches the real test build of the extension the way the
// walkthroughs do (e2e/support/test.ts); run `pnpm e2e`'s build step first: `pnpm -C apps/extension build:e2e`.
export default defineConfig({
  testDir: '.',
  testMatch: /record\.spec\.ts$/,
  timeout: 30 * 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: process.env.SOP_VIDEO_OUT ?? '../.record-results',
});
