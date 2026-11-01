// The Worker's tests run on workerd (the real Workers runtime) under Miniflare, through @cloudflare/vitest-plugin. This file is
// the `cloud` project that the root vitest.config.ts includes. Tests live in `src/**/*.test.ts` and `test/**/*.test.ts`.
//
// Nothing here reaches a real Cloudflare account or the internet: storage is temporary, the Worker's outbound `fetch` goes to the
// fakes in test/fake-github.ts (anything else answers 502), and the secrets are throwaway test values.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { FAKE_OWNER, createFakeInternet } from './test/fake-github.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(async () => {
  const internet = createFakeInternet();
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: here('./wrangler.jsonc') },
        miniflare: {
          bindings: {
            PUBLIC_URL: 'https://sickofpdfs.test',
            GITHUB_CLIENT_ID: 'fake-client-id',
            GITHUB_CLIENT_SECRET: 'fake-secret',
            ALLOWED_GITHUB_ID: String(FAKE_OWNER.id),
            SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
            SOP_EXPORT_TOKEN: 'test-export-token',
            GITHUB_BASE_URL: `https://${internet.githubHost}`,
            GITHUB_API_URL: `https://${internet.githubHost}`,
            // read by test/setup.ts, which applies the same migrations the real databases get
            TEST_META_MIGRATIONS: await readD1Migrations(here('./migrations/meta')),
            TEST_TEXT_MIGRATIONS: await readD1Migrations(here('./migrations/text')),
          },
          outboundService: async (request: Request) => {
            const r = internet.handle({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body: request.method === 'GET' ? '' : await request.text() });
            return new Response(r.body, { status: r.status, headers: r.headers });
          },
        },
      }),
    ],
    test: {
      name: 'cloud',
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
      setupFiles: [here('./test/setup.ts')],
      // workerd start-up is slow the first time
      testTimeout: 20_000,
      hookTimeout: 30_000,
    },
  };
});
