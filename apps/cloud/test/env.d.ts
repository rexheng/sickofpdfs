// Gives `import { env } from 'cloudflare:workers'` (and 'cloudflare:test') the Worker's own bindings, plus the ones tests add.
import type { Env as WorkerEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Set by vitest.config.ts: the migration files, applied by test/setup.ts. */
      TEST_META_MIGRATIONS: import('cloudflare:test').D1Migration[];
      TEST_TEXT_MIGRATIONS: import('cloudflare:test').D1Migration[];
    }
  }
}
export {};
