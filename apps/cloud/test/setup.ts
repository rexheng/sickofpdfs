// Runs inside workerd before each test file: gives the test databases the same schema the real ones get.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from 'cloudflare:test';

const bindings = env as unknown as Record<string, unknown>;
await applyD1Migrations(env.META, bindings.TEST_META_MIGRATIONS as D1Migration[]);
for (const [name, db] of Object.entries(bindings)) {
  if (/^TEXT_\d+$/.test(name)) await applyD1Migrations(db as D1Database, bindings.TEST_TEXT_MIGRATIONS as D1Migration[]);
}
