import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// Never collected, by either project. spikes/** is the throwaway Phase 0 package with its own Playwright suite.
const exclude = [...configDefaults.exclude, '**/.output/**', '**/.wxt/**', 'test-assets/**', 'spikes/**'];

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
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
