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
