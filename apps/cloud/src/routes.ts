// The route table. Each area is a Hono app that owns a set of paths; they are mounted in an order where the areas with exact
// API paths come before the web's catch-all. Areas replace their own `app.ts` and never edit this file (a new area is the only
// reason to). The paths each area owns are the contracts' CA3.
import { Hono } from 'hono';
import { authApp } from './auth/app';
import { type AppEnv, textShards } from './env';
import { exportApp } from './export/app';
import { mcpApp } from './mcp/app';
import { queryApp } from './query/app';
import { syncApp } from './sync/app';
import { webApp } from './web/app';

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Always answers, needs no sign-in, and says nothing about the library. The smoke test and uptime checks use it.
  app.get('/api/health', (c) => c.json({ ok: true, service: 'sickofpdfs', environment: c.env.ENVIRONMENT }, 200, { 'cache-control': 'no-store' }));

  // Local only (404 anywhere else): which tables the migrations created, to show the schema is applied.
  app.get('/api/health/db', async (c) => {
    if (c.env.ENVIRONMENT !== 'local') return c.json({ error: 'not_found' }, 404);
    const tables = async (db: D1Database) =>
      (await db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','trigger','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\\_fts\\_%' ESCAPE '\\' ORDER BY type, name").all<{ name: string }>()).results.map((r) => r.name);
    const count = async (db: D1Database, table: string) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
    const shards = textShards(c.env);
    return c.json({
      ok: true,
      meta: { objects: (await tables(c.env.META)).length, documents: await count(c.env.META, 'documents'), devices: await count(c.env.META, 'device'), settings: await count(c.env.META, 'setting') },
      text: await Promise.all(shards.map(async (d, i) => ({ shard: i, objects: (await tables(d)).length, pages: await count(d, 'page') }))),
    });
  });

  app.route('/', authApp);
  app.route('/', syncApp);
  app.route('/', queryApp);
  app.route('/', mcpApp);
  app.route('/', exportApp);
  app.route('/', webApp); // last: its catch-all serves the static assets
  return app;
}
