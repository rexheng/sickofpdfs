// CL8 · The nightly cloud backup (spec "Cloud backup"): pages through /api/export for every table and writes each page into
// the Worker's own R2 under backup/<date>/ (kept 30 days by the daily job). Production only.
//
//   SOP_EXPORT_TOKEN=… node scripts/backup.mjs --url https://sickofpdfs.<you>.workers.dev
//   (or SESSION_SECRET=… and --env production: the token is made from it the same way bootstrap makes it)
import { arg, derivedSecret } from './cloud-env.mjs';

const W = (arg('url') ?? '').replace(/\/$/, '');
const token = process.env.SOP_EXPORT_TOKEN ?? (process.env.SESSION_SECRET ? derivedSecret(process.env.SESSION_SECRET, 'export', arg('env', 'production')) : null);
if (!/^https?:\/\//.test(W) || !token) {
  console.error('usage: SOP_EXPORT_TOKEN=… node scripts/backup.mjs --url <worker address>');
  process.exit(2);
}
const auth = { authorization: `Bearer ${token}` };
const date = new Date().toISOString().slice(0, 10);
const first = await fetch(`${W}/api/export/__list__`, { headers: auth });
if (first.status === 401) throw new Error('the export token was refused');
const tables = (await first.json()).tables;
let parts = 0;
let rows = 0;
for (const table of tables) {
  let after = null;
  let n = 0;
  do {
    const q = new URLSearchParams({ limit: '1000', ...(after ? { after } : {}) });
    const res = await fetch(`${W}/api/export/${table}?${q}`, { headers: auth });
    if (!res.ok) throw new Error(`export ${table} answered ${res.status}`);
    const page = await res.json();
    const body = JSON.stringify(page);
    const put = await fetch(`${W}/api/backup/${date}/${table.replaceAll('_', '-')}-${String(n).padStart(4, '0')}.json`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body });
    if (!put.ok) throw new Error(`backup ${table} part ${n} answered ${put.status}`);
    rows += page.rows.length;
    parts++;
    n++;
    after = page.next;
  } while (after);
}
console.log(`backup ${date}: ${tables.length} tables, ${parts} parts, ${rows} rows`);
