// CL13: the web library's side of the Worker.
//
//   GET /, /d/<sha>         the web library (a single-page app in the static assets). Signed out: to /login, coming back here.
//   GET /viewer?doc=<sha>   CL14: the PDF viewer (viewer.html), the same way. The PDF itself comes from /api/blobs/<sha>.
//   GET /api/web/overview   cookie only: today's use of the daily write budget, the devices that sync, and how big the
//                           library is, for Settings.
//   everything else         the static assets (apps/cloud/public, built from apps/cloud/web), with their security headers.
//
// The library page itself holds nothing private: everything in it comes from /api after the session is checked. The redirect
// is only so a signed-out visit goes straight to "Sign in" instead of showing an empty frame first.
import { type Context, Hono } from 'hono';
import { requireAuth } from '../auth/authenticate';
import { isOwner } from '../auth/github';
import { getSession } from '../auth/session';
import type { AppEnv } from '../env';
import { limits, utcDay } from '../sync/meter';

export const webApp = new Hono<AppEnv>();

/**
 * The library loads only its own files; the database engine and the PDF engine (PDFium) need WebAssembly, which
 * 'wasm-unsafe-eval' allows without allowing eval. The same list as web/public/_headers.
 */
export const WEB_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' blob: data:; font-src 'self'; style-src 'self' 'unsafe-inline'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

function withSecurityHeaders(res: Response, html: boolean): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'same-origin');
  if (html) {
    h.set('content-security-policy', WEB_CSP);
    h.set('x-frame-options', 'DENY');
    h.set('cross-origin-opener-policy', 'same-origin');
    h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    h.set('cache-control', 'no-store');
  }
  return out;
}

webApp.get('/api/web/overview', requireAuth({ cookieOnly: true }), async (c) => {
  const db = c.env.META;
  const [usage, devices, docs, notes] = await db.batch([
    db.prepare('SELECT text_rows, note_rows FROM usage_day WHERE day = ?').bind(utcDay()),
    db.prepare("SELECT id, name, kind, created_at, last_seen_at FROM device WHERE kind <> 'claude' ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 50"),
    db.prepare('SELECT count(*) AS n, COALESCE(sum(byte_size), 0) AS bytes, COALESCE(sum(blob_stored), 0) AS stored FROM documents d WHERE d.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM forgotten f WHERE f.document_id = d.id AND d.created_at <= f.at)'),
    db.prepare('SELECT count(*) AS n FROM comments WHERE deleted_at IS NULL AND draft_of_tab IS NULL'),
  ]);
  const u = (usage?.results[0] ?? null) as { text_rows: number; note_rows: number } | null;
  const lim = limits(c.env);
  const d = (docs?.results[0] ?? {}) as { n?: number; bytes?: number; stored?: number };
  const auth = c.get('auth');
  return c.json(
    {
      today: { textRows: u?.text_rows ?? 0, noteRows: u?.note_rows ?? 0, textLimit: lim.text, notesLimit: lim.notes },
      library: { readings: d.n ?? 0, bytes: d.bytes ?? 0, pdfsStored: d.stored ?? 0, notes: (notes?.results[0] as { n?: number } | undefined)?.n ?? 0 },
      devices: (devices?.results ?? []).map((r) => {
        const x = r as { id: string; name: string; kind: string; created_at: number; last_seen_at: number | null };
        return { id: x.id, name: x.name, kind: x.kind, createdAt: x.created_at, lastSeenAt: x.last_seen_at, thisBrowser: x.id === auth?.device };
      }),
    },
    200,
    { 'cache-control': 'no-store' },
  );
});

/** The library's own addresses: only for the owner's session. Anyone else is sent to sign in, and learns nothing. */
async function libraryPage(c: Context<AppEnv>, asset = '/'): Promise<Response> {
  const s = await getSession(c.env, c.req.raw);
  if (!s || !isOwner(c.env, s.uid)) {
    const url = new URL(c.req.url);
    return new Response(null, { status: 302, headers: { location: `/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 'cache-control': 'no-store' } });
  }
  const index = new URL(asset, c.req.url); // the assets answer / with index.html (and /index.html with a redirect to /)
  return withSecurityHeaders(await c.env.ASSETS.fetch(new Request(index, { headers: c.req.raw.headers })), true);
}
webApp.get('/', (c) => libraryPage(c));
webApp.get('/d/:sha{[0-9a-f]{64}}', (c) => libraryPage(c));
// The assets answer /viewer with viewer.html (and /viewer.html with a redirect to /viewer).
webApp.get('/viewer', (c) => libraryPage(c, '/viewer'));

webApp.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  return withSecurityHeaders(res, (res.headers.get('content-type') ?? '').startsWith('text/html'));
});
