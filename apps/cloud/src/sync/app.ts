// CL4: the sync API (contracts CA3). Every route needs the `sync` permission: a sync token from our own apps, or the web
// library's session cookie (whose changes also need our Origin and the CSRF token). A connector token never works here.
//
//   POST   /api/devices                          register this sign-in's device (or bind a known one to it)
//   GET    /api/devices                          the devices that sync (CL12: the extension's Settings → Cloud lists them)
//   GET    /api/sync/head                        { head }
//   GET    /api/sync/pull?since=&limit=          PullResponse
//   POST   /api/sync/push                        PushRequest -> PushResponse (with `rejected`, CA10)
//   PUT    /api/text/:sha    GET /api/text/:sha?from=&limit=
//   HEAD   /api/blobs/:sha   PUT (≤ 32 MiB)   GET (Range)
//   POST   /api/blobs/:sha/multipart   PUT …/multipart/:part   POST …/multipart/complete   DELETE …/multipart
//   PUT    /api/thumbs/:sha  GET /api/thumbs/:sha
//   DELETE /api/documents/:sha                   Forget
//
// The Android app's web view and the extension call from other origins with a bearer token, so these routes answer CORS for
// those origins only, and never with credentials (a cookie never crosses origins).

import type { Sha256 } from '@sop/core';
import type { ChangeEntry } from '@sop/core/sync';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { audit } from '../auth/audit';
import { requireAuth } from '../auth/authenticate';
import { FIRST_PARTY_CLIENTS, oauthApi } from '../auth/server';
import type { AppEnv, Env } from '../env';
import { wiring } from '../seams';
import { BlobError, abortMultipart, completeMultipart, getBlob, getThumb, headBlob, putBlob, putPart, putThumb, startMultipart } from './blobs';
import { QuotaError, quotaResponse } from './meter';
import { BusyError, PushRequestError, createSyncService } from './service';
import { MAX_TEXT_BODY, TextError, getText, parseTextPut, putText } from './text';

// The connector (CL6) writes through the same service, as device `claude` (seams.ts).
wiring.syncService = createSyncService;

export const syncApp = new Hono<AppEnv>();

const SHA = '/:sha{[0-9a-f]{64}}';
const MAX_PUSH_BODY = 4 * 1024 * 1024;
const noStore = { 'cache-control': 'no-store' } as const;

// ─── CORS for our apps ─────────────────────────────────────────────────────────────────────────────────────────────────

function appOrigins(env: Env): string[] {
  // Capacitor's web view (Android https/http, iOS) and the extension's own pages
  return ['https://localhost', 'http://localhost', 'capacitor://localhost', `chrome-extension://${env.EXTENSION_ID}`];
}

const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('origin');
  const allowed = origin !== undefined && appOrigins(c.env).includes(origin);
  if (c.req.method === 'OPTIONS') {
    if (!allowed) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '86400',
        vary: 'Origin',
      },
    });
  }
  await next();
  if (allowed) {
    c.res.headers.set('access-control-allow-origin', origin);
    c.res.headers.set('access-control-expose-headers', 'retry-after, www-authenticate, content-range, content-length, etag');
    c.res.headers.append('vary', 'Origin');
  }
};

for (const p of ['/api/devices', '/api/sync/*', '/api/text/*', '/api/blobs/*', '/api/thumbs/*', '/api/documents/*']) syncApp.use(p, cors);
const sync = requireAuth({ scopes: ['sync'] });

/** The known failures as plain answers; anything else is a real error. */
function failure(c: Context<AppEnv>, e: unknown): Response {
  if (e instanceof QuotaError) return quotaResponse(e);
  if (e instanceof BusyError) return c.json({ error: 'busy', message: e.message }, 503, { ...noStore, 'retry-after': '2' });
  if (e instanceof PushRequestError || e instanceof TextError || e instanceof BlobError) return c.json({ error: e.code, message: e.message }, e.status, noStore);
  throw e;
}

// ─── Devices ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const DEVICE_KINDS: Record<string, 'extension' | 'android'> = { [FIRST_PARTY_CLIENTS.extension]: 'extension', [FIRST_PARTY_CLIENTS.android]: 'android' };
const PREFIX = { extension: 'ext', android: 'android' } as const;

syncApp.post('/api/devices', sync, async (c) => {
  const auth = c.get('auth');
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  const head = await createSyncService(c.env).head();
  if (auth.kind === 'cookie') return c.json({ device: auth.device, head }, 200, noStore);
  const kind = auth.clientId ? DEVICE_KINDS[auth.clientId] : undefined;
  if (!kind) return c.json({ error: 'not_a_sync_app', message: 'Only the sickofpdfs apps sync.' }, 403, noStore);
  const body: { id?: unknown; name?: unknown } = (await c.req.json<unknown>().catch(() => null)) ?? {};
  const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 100) : kind === 'extension' ? 'Chrome' : 'Android phone';
  const grantId = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').split(':')[1] ?? '';
  const now = Date.now();
  const db = c.env.META;

  // A device that signed in again keeps its id (and its replay memory); its earlier sign-in is ended
  if (typeof body.id === 'string' && new RegExp(`^${PREFIX[kind]}-[0-9a-f]{16}$`).test(body.id)) {
    const known = await db.prepare('SELECT id, kind, grant_id FROM device WHERE id = ?').bind(body.id).first<{ id: string; kind: string; grant_id: string | null }>();
    if (known && known.kind === kind) {
      await db.batch([
        db.prepare('UPDATE device SET grant_id = NULL WHERE grant_id = ? AND id <> ?').bind(grantId, known.id),
        db.prepare('UPDATE device SET grant_id = ?, client_id = ?, name = ?, last_seen_at = ? WHERE id = ?').bind(grantId, auth.clientId, name, now, known.id),
      ]);
      if (known.grant_id && known.grant_id !== grantId) await oauthApi(c.env).revokeGrant(known.grant_id, auth.uid).catch(() => undefined);
      return c.json({ device: known.id, head }, 200, noStore);
    }
  }
  if (auth.device) return c.json({ device: auth.device, head }, 200, noStore);
  const id = `${PREFIX[kind]}-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  await db.batch([
    db.prepare('UPDATE device SET grant_id = NULL WHERE grant_id = ?').bind(grantId),
    db.prepare('INSERT INTO device (id, name, kind, created_at, last_seen_at, grant_id, client_id) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, name, kind, now, now, grantId, auth.clientId),
  ]);
  await audit(c.env, { actor: 'owner', clientId: auth.clientId, action: 'device.create', target: kind });
  return c.json({ device: id, head }, 201, noStore);
});

syncApp.get('/api/devices', sync, async (c) => {
  const auth = c.get('auth');
  const rows = await c.env.META.prepare("SELECT id, name, kind, created_at, last_seen_at FROM device WHERE kind <> 'claude' ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 50").all<{
    id: string;
    name: string;
    kind: string;
    created_at: number;
    last_seen_at: number | null;
  }>();
  const devices = (rows.results ?? []).map((r) => ({ id: r.id, name: r.name, kind: r.kind, createdAt: r.created_at, lastSeenAt: r.last_seen_at, thisDevice: r.id === auth?.device }));
  return c.json({ devices }, 200, noStore);
});

// ─── Head, pull, push ──────────────────────────────────────────────────────────────────────────────────────────────────

syncApp.get('/api/sync/head', sync, async (c) => c.json({ head: await createSyncService(c.env).head() }, 200, noStore));

syncApp.get('/api/sync/pull', sync, async (c) => {
  const since = Number(c.req.query('since') ?? '0');
  const limit = Number(c.req.query('limit') ?? '200');
  if (!Number.isSafeInteger(since) || since < 0) return c.json({ error: 'bad_cursor', message: 'since must be a whole number from 0' }, 400, noStore);
  const res = await createSyncService(c.env).pull(since, Number.isFinite(limit) ? limit : 200);
  const device = c.get('auth')?.device;
  if (device) await c.env.META.prepare('UPDATE device SET last_seen_at = ?, last_pull_seq = ? WHERE id = ?').bind(Date.now(), res.cursor, device).run().catch(() => undefined);
  return c.json(res, 200, noStore);
});

syncApp.post('/api/sync/push', sync, async (c) => {
  const auth = c.get('auth');
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (!auth.device) return c.json({ error: 'device_not_registered', message: 'Register this device first (POST /api/devices).' }, 409, noStore);
  const len = Number(c.req.header('content-length') ?? '0');
  if (len > MAX_PUSH_BODY) return c.json({ error: 'too_large', message: 'Send fewer entries in one push (at most 4 MiB).' }, 413, noStore);
  const text = await c.req.text();
  if (text.length > MAX_PUSH_BODY) return c.json({ error: 'too_large', message: 'Send fewer entries in one push (at most 4 MiB).' }, 413, noStore);
  let body: { device?: unknown; entries?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return c.json({ error: 'bad_request', message: 'The body must be JSON.' }, 400, noStore);
  }
  // The device comes from the sign-in, never from the body. A body that names another one is a bug on the device: say so.
  if (body.device !== undefined && body.device !== auth.device) return c.json({ error: 'device_mismatch', message: 'This sign-in syncs as another device.' }, 409, noStore);
  try {
    return c.json(await createSyncService(c.env).push(auth.device, body.entries as ChangeEntry[]), 200, noStore);
  } catch (e) {
    return failure(c, e);
  }
});

// ─── Page text ─────────────────────────────────────────────────────────────────────────────────────────────────────────

syncApp.put(`/api/text${SHA}`, sync, async (c) => {
  const len = Number(c.req.header('content-length') ?? '0');
  if (len > MAX_TEXT_BODY) return c.json({ error: 'too_large', message: 'Send at most 1 MiB of text at a time.' }, 413, noStore);
  const raw = await c.req.text();
  if (raw.length > MAX_TEXT_BODY) return c.json({ error: 'too_large', message: 'Send at most 1 MiB of text at a time.' }, 413, noStore);
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TextError(400, 'bad_body', 'The body must be JSON.');
    }
    return c.json(await putText(c.env, c.req.param('sha'), parseTextPut(parsed)), 200, noStore);
  } catch (e) {
    return failure(c, e);
  }
});

syncApp.get(`/api/text${SHA}`, sync, async (c) => {
  const from = Math.max(0, Math.floor(Number(c.req.query('from') ?? '0')) || 0);
  const limit = Math.min(200, Math.max(1, Math.floor(Number(c.req.query('limit') ?? '50')) || 50));
  const r = await getText(c.env, c.req.param('sha'), from, limit);
  return r ? c.json(r, 200, noStore) : c.json({ error: 'not_found', message: 'No text for this document.' }, 404, noStore);
});

// ─── PDFs ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

syncApp.on('HEAD', `/api/blobs${SHA}`, sync, async (c) => {
  const h = await headBlob(c.env, c.req.param('sha'));
  return new Response(null, { status: h ? 200 : 404, headers: { ...noStore, ...(h ? { 'content-length': String(h.size), 'content-type': 'application/pdf' } : {}) } });
});

syncApp.put(`/api/blobs${SHA}`, sync, async (c) => {
  try {
    return c.json(await putBlob(c.env, c.req.param('sha'), c.req.raw), 200, noStore);
  } catch (e) {
    return failure(c, e);
  }
});

syncApp.get(`/api/blobs${SHA}`, sync, async (c) => {
  const r = await getBlob(c.env, c.req.param('sha'), c.req.raw);
  return r ?? c.json({ error: 'not_found', message: 'This PDF is not in your cloud.' }, 404, noStore);
});

syncApp.post(`/api/blobs${SHA}/multipart`, sync, async (c) => {
  try {
    return c.json(await startMultipart(c.env, c.req.param('sha')), 200, noStore);
  } catch (e) {
    return failure(c, e);
  }
});

syncApp.post(`/api/blobs${SHA}/multipart/complete`, sync, async (c) => {
  try {
    return c.json(await completeMultipart(c.env, c.req.param('sha')), 200, noStore);
  } catch (e) {
    return failure(c, e);
  }
});

syncApp.put(`/api/blobs${SHA}/multipart/:part{[0-9]{1,5}}`, sync, async (c) => {
  try {
    return c.json(await putPart(c.env, c.req.param('sha'), Number(c.req.param('part')), c.req.raw), 200, noStore);
  } catch (e) {
    return failure(c, e);
  }
});

syncApp.delete(`/api/blobs${SHA}/multipart`, sync, async (c) => {
  await abortMultipart(c.env, c.req.param('sha'));
  return c.json({ ok: true }, 200, noStore);
});

// ─── Thumbnails ────────────────────────────────────────────────────────────────────────────────────────────────────────

syncApp.put(`/api/thumbs${SHA}`, sync, async (c) => {
  try {
    await putThumb(c.env, c.req.param('sha'), c.req.raw);
    return c.json({ ok: true }, 200, noStore);
  } catch (e) {
    return failure(c, e);
  }
});

syncApp.get(`/api/thumbs${SHA}`, sync, async (c) => (await getThumb(c.env, c.req.param('sha'))) ?? c.json({ error: 'not_found' }, 404, noStore));

// ─── Forget ────────────────────────────────────────────────────────────────────────────────────────────────────────────

syncApp.delete(`/api/documents${SHA}`, sync, async (c) => {
  try {
    await createSyncService(c.env).purgeDocument(c.req.param('sha') as Sha256);
    return c.json({ ok: true, forgotten: true }, 200, noStore);
  } catch (e) {
    return failure(c, e);
  }
});
