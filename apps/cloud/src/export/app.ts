// CL7: the nightly cloud backup and the daily housekeeping.
//
//   GET  /api/export/:table?after=&limit=   one page of a table, for the backup job (GitHub Actions). Every synced table and
//                                           every server table; never the search tables (they are rebuilt from the rows) and
//                                           never page text (each device has it, and it is rebuilt from the PDFs).
//   PUT  /api/backup/:date/:part            the job writes each page back as JSON into R2 `backup/<date>/<part>`
//   GET  /api/backup, /api/backup/:date/:part   what is there, and one part (for a restore)
//
// All three take only `Authorization: Bearer <SOP_EXPORT_TOKEN>` (a Worker secret), compared in constant time. No sign-in
// token works here and the export token works nowhere else.
//
// The daily job (cron 17 3 * * *) keeps 30 days of backups and of replay memory, aborts uploads left for 7 days, keeps 180 days
// of audit rows, and hard-purges documents that have been in Trash for 30 days (D8), so Trash purge needs no call from a device.

import { SYNCED_TABLES } from '@sop/core/sync';
import { Hono } from 'hono';
import { clientAddress, tooManyRequests, withinLimit } from '../auth/authenticate';
import { constantTimeEqual } from '../auth/github';
import type { AppEnv, Env } from '../env';
import { pkColumn } from '../sync/rows';
import { dailyJob } from './jobs';

export const exportApp = new Hono<AppEnv>();

/** Every table the backup holds, with the column (or columns) it pages by. */
const EXPORT_KEYS: Record<string, readonly string[]> = {
  ...Object.fromEntries(SYNCED_TABLES.map((t) => [t, [pkColumn(t)]])),
  device: ['id'],
  applied_entry: ['device', 'table_name', 'row_id'],
  blob_upload: ['sha256'],
  audit: ['id'],
  usage_day: ['day'],
  setting: ['key'],
  doc_text: ['document_id'],
  forgotten: ['document_id'],
  removed_row: ['table_name', 'row_id'],
  sync_counter: ['id'],
};

const noStore = { 'cache-control': 'no-store' } as const;
const MAX_PAGE_BYTES = 4_000_000;
const MAX_BACKUP_BYTES = 90 * 1024 * 1024;

function exportTokenOk(env: Env, req: Request): boolean {
  const want = env.SOP_EXPORT_TOKEN ?? '';
  const got = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  // A missing or short secret lets nobody in
  return want.length >= 16 && got !== '' && constantTimeEqual(got, want);
}

exportApp.use('/api/export/*', async (c, next) => {
  if (!(await withinLimit(c.env.RL_API, `export:${clientAddress(c.req.raw)}`))) return tooManyRequests();
  if (!exportTokenOk(c.env, c.req.raw)) return c.json({ error: 'unauthorized' }, 401, noStore);
  await next();
});
exportApp.use('/api/backup', async (c, next) => {
  if (!exportTokenOk(c.env, c.req.raw)) return c.json({ error: 'unauthorized' }, 401, noStore);
  await next();
});
exportApp.use('/api/backup/*', async (c, next) => {
  if (!(await withinLimit(c.env.RL_API, `export:${clientAddress(c.req.raw)}`))) return tooManyRequests();
  if (!exportTokenOk(c.env, c.req.raw)) return c.json({ error: 'unauthorized' }, 401, noStore);
  await next();
});

/** A BLOB column (history.pages_visited) as `{ $base64 }`, so the JSON can be put back byte for byte. */
function exportValue(v: unknown): unknown {
  if (v instanceof ArrayBuffer || v instanceof Uint8Array || (Array.isArray(v) && v.every((x) => typeof x === 'number'))) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : v instanceof Uint8Array ? v : Uint8Array.from(v);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { $base64: btoa(s) };
  }
  return v;
}

exportApp.get('/api/export/:table', async (c) => {
  const table = c.req.param('table');
  const keys = EXPORT_KEYS[table];
  if (!keys) return c.json({ error: 'unknown_table', tables: Object.keys(EXPORT_KEYS) }, 404, noStore);
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(c.req.query('limit') ?? '500')) || 500));
  const after = c.req.query('after');
  let where = '';
  let binds: unknown[] = [];
  if (after !== undefined && after !== '') {
    let parts: unknown[];
    try {
      parts = keys.length === 1 ? [table === 'audit' || table === 'sync_counter' ? Number(after) : after] : (JSON.parse(after) as unknown[]);
    } catch {
      return c.json({ error: 'bad_cursor' }, 400, noStore);
    }
    if (!Array.isArray(parts) || parts.length !== keys.length || parts.some((p) => typeof p !== 'string' && typeof p !== 'number')) return c.json({ error: 'bad_cursor' }, 400, noStore);
    where = `WHERE (${keys.join(', ')}) > (${keys.map(() => '?').join(', ')})`;
    binds = parts;
  }
  const r = await c.env.META.prepare(`SELECT * FROM ${table} ${where} ORDER BY ${keys.join(', ')} LIMIT ?`).bind(...binds, limit + 1).all<Record<string, unknown>>();
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const row of r.results.slice(0, limit)) {
    const out = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, exportValue(v)]));
    const size = JSON.stringify(out).length;
    if (rows.length > 0 && bytes + size > MAX_PAGE_BYTES) break;
    rows.push(out);
    bytes += size;
  }
  const more = rows.length < r.results.length;
  const last = rows[rows.length - 1];
  const next = more && last ? (keys.length === 1 ? String(last[keys[0]]) : JSON.stringify(keys.map((k) => last[k]))) : null;
  return c.json({ table, rows, next }, 200, noStore);
});

const DATE = ':date{[0-9]{4}-[0-9]{2}-[0-9]{2}}';
const PART = ':part{[a-z0-9][a-z0-9_.-]{0,79}}';

exportApp.get('/api/backup', async (c) => {
  const dates: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.env.BLOBS.list({ prefix: 'backup/', delimiter: '/', ...(cursor ? { cursor } : {}) });
    for (const p of page.delimitedPrefixes) dates.push(p.slice('backup/'.length, -1));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return c.json({ dates: dates.sort() }, 200, noStore);
});

exportApp.put(`/api/backup/${DATE}/${PART}`, async (c) => {
  const len = Number(c.req.header('content-length') ?? 'NaN');
  if (!Number.isSafeInteger(len) || len <= 0) return c.json({ error: 'length_required' }, 411, noStore);
  if (len > MAX_BACKUP_BYTES) return c.json({ error: 'too_large' }, 413, noStore);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: 'no_body' }, 400, noStore);
  const type = c.req.header('content-type') === 'application/gzip' ? 'application/gzip' : 'application/json';
  await c.env.BLOBS.put(`backup/${c.req.param('date')}/${c.req.param('part')}`, body, { httpMetadata: { contentType: type } });
  return c.json({ ok: true }, 200, noStore);
});

exportApp.get(`/api/backup/${DATE}/${PART}`, async (c) => {
  const o = await c.env.BLOBS.get(`backup/${c.req.param('date')}/${c.req.param('part')}`);
  if (!o) return c.json({ error: 'not_found' }, 404, noStore);
  return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType ?? 'application/json', ...noStore } });
});

/** The cron trigger (17 3 * * *). */
export const scheduled = (event: ScheduledController, env: Env): Promise<void> => dailyJob(env, event.scheduledTime).then(() => undefined);
