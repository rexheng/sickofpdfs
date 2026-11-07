import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));



// Never collected, by either project. spikes/** is the throwaway Phase 0 package with its own Playwright suite.
const exclude = [...configDefaults.exclude, '**/.output/**', '**/.wxt/**', 'test-assets/**', 'spikes/**'];

// The release workflow (SOP_NO_FIXTURES=1) has no test-assets/: the real PDFs are not in git. These three test files read them,
// so the workflow skips them; they run on the owner's machine and in the release checklist.
const needRealPdfs = process.env.SOP_NO_FIXTURES === '1' ? ['**/classify-fixtures.spec-blind.test.ts', '**/classify-speed.spec-blind.test.ts', '**/pdf-mapping.spec-blind.test.ts'] : [];

export default defineConfig({
  test: {
    projects: [
      // The Worker's tests run on workerd under Miniflare (apps/cloud/vitest.config.ts), not in Node
      './apps/cloud/vitest.config.ts',
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['**/*.test.{ts,js}'],
          exclude: [...exclude, ...needRealPdfs, '**/*.browser.test.*', 'apps/cloud/**'],
        },
      },
      {
        // `pnpm test:browser`: real Chromium (the preinstalled one locally; CI installs it in the workflow)
        server: { fs: { allow: [repoRoot] } },
        // Vite's dependency scan reads the test files' imports but never follows `new Worker(new URL(...))`, so on a cold cache it
        // found the workers' packages (@embedpdf/* for the engine, @sqlite.org/sqlite-wasm for the store) mid-run and reloaded, and
        // only 3 of the test files ran (TB6 gate). Every worker file is scanned as an entry too (vitest adds the test files to
        // these). Not `include`: pnpm keeps those packages under their own workspace package, where a name given from the root
        // does not resolve.
        optimizeDeps: { entries: ['{apps,packages}/*/{src,test}/**/*worker.ts'] },
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
