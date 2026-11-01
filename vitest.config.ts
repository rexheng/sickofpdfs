import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// Spec-blind tests that run the real store over real SQLite import Task 28's files (and its sqlite-wasm dependency), so
// before Task 28 exists they cannot even load. They switch on by themselves the moment store-api.ts is there.
// Delete this block when Task 28 has merged.
const needTask28 = existsSync(new URL('./apps/extension/src/store/store-api.ts', import.meta.url))
  ? []
  : [
      '**/store/schema-v2.spec-blind.test.ts',
      '**/store/annotations.spec-blind.test.ts',
      '**/store/durability.spec-blind.browser.test.ts',
      '**/viewer/annotations/no-lost-text.spec-blind.test.ts',
      '**/viewer/annotations/edit-draft.spec-blind.test.ts',
    ];

// Never collected, by either project. spikes/** is the throwaway Phase 0 package with its own Playwright suite.
const exclude = [...needTask28, ...configDefaults.exclude, '**/.output/**', '**/.wxt/**', 'test-assets/**', 'spikes/**'];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['**/*.test.{ts,js}'],
          exclude: [...exclude, '**/*.browser.test.*'],
        },
      },
      {
        // `pnpm test:browser`: real Chromium (the preinstalled one locally; CI installs it in the workflow)
        server: { fs: { allow: [repoRoot] } },
        test: {
          name: 'browser',
          include: ['**/*.browser.test.{ts,tsx}'],
          exclude,
          // Fills apps/extension/public/pdf/ (pdfium.wasm and the fallback fonts) from the installed packages before any
          // test, so engine tests never depend on an earlier extension build; then starts the e2e fixture server
          // (`inject('fixtureOrigin')`).
          globalSetup: ['./apps/extension/scripts/copy-engine-assets.mjs', 'e2e/support/vitest-global-setup.ts'],
          browser: {
            enabled: true,
            // Chromium reports exact heap sizes (performance.memory), which the blob store's memory test reads.
            provider: playwright({ launchOptions: { args: ['--enable-precise-memory-info'] } }),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
