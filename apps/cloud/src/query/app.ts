// CL5: the read routes behind `QueryApi` (CA3): search, documents, notes, activity, me. Bearer (library:read or sync) or cookie.
// These are the owner's own tools (the extension, the web library), so they see Trash and every reading. The connector at /mcp
// uses the same queries with the narrower `connector` audience.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { requireScope } from '../guard';
import type { LibraryQuery, SearchHit } from '../seams';
import { createQueryApi } from './api';

export const queryApp = new Hono<AppEnv>();

const HEX64 = /^[0-9a-f]{64}$/;
const int = (v: string | undefined, fallback: number, min: number, max: number): number => {
  const x = v === undefined ? NaN : Number(v);
  return Number.isFinite(x) ? Math.max(min, Math.min(max, Math.trunc(x))) : fallback;
};
const bool = (v: string | undefined): boolean | undefined => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : undefined);

const noStore = { 'cache-control': 'private, no-store' };

/** Runs a handler for a signed-in caller who may read; keeps the error text short and plain. */
async function guarded(c: Context<AppEnv>, run: (api: ReturnType<typeof createQueryApi>) => Promise<unknown>): Promise<Response> {
  const auth = await requireScope(c, 'api', ['library:read', 'sync']);
  if (auth instanceof Response) return auth;
  try {
    return c.json(await run(createQueryApi(c.env, 'owner')), 200, noStore);
  } catch (e) {
    console.error('query failed', e instanceof Error ? e.message : 'unknown');
    return c.json({ error: 'query_failed' }, 500, noStore);
  }
}

queryApp.get('/api/me', async (c) => {
  const auth = await requireScope(c, 'api', ['library:read', 'sync']);
  if (auth instanceof Response) return auth;
  return c.json({ uid: auth.uid, kind: auth.kind, scopes: auth.scopes }, 200, noStore);
});

queryApp.get('/api/search', (c) => {
  const kinds = (c.req.query('kinds') ?? '').split(',').filter((k): k is SearchHit['kind'] => k === 'reading' || k === 'page' || k === 'note');
  const doc = c.req.query('doc');
  return guarded(c, async (api) =>
    api.search({
      text: (c.req.query('q') ?? '').slice(0, 300),
      ...(doc && HEX64.test(doc) ? { documentId: doc as never } : {}),
      ...(kinds.length ? { kinds } : {}),
      limit: int(c.req.query('limit'), 20, 1, 50),
    }),
  );
});

queryApp.get('/api/documents', (c) => {
  const view = c.req.query('view');
  const by = c.req.query('sort');
  const kind = (c.req.query('kind') ?? '').split(',').filter((k): k is 'paper' | 'book' | 'slides' | 'other' => ['paper', 'book', 'slides', 'other'].includes(k));
  const filter: NonNullable<LibraryQuery['filter']> = {};
  const starred = bool(c.req.query('starred'));
  const hasNotes = bool(c.req.query('hasNotes'));
  if (starred !== undefined) filter.starred = starred;
  if (hasNotes !== undefined) filter.hasNotes = hasNotes;
  if (kind.length) filter.kind = kind;
  const title = c.req.query('title');
  if (title) filter.titleContains = title.slice(0, 200);
  const cursor = c.req.query('cursor');
  return guarded(c, (api) =>
    api.listDocuments({
      view: view === 'recent' || view === 'starred' || view === 'trash' ? view : 'all',
      sort: { by: by === 'title' || by === 'lastOpened' || by === 'pages' ? by : 'added', dir: c.req.query('dir') === 'asc' ? 'asc' : 'desc' },
      filter,
      limit: int(c.req.query('limit'), 30, 1, 50),
      ...(cursor ? { cursor } : {}),
    }),
  );
});

queryApp.get('/api/documents/:id', (c) => {
  const id = c.req.param('id');
  if (!HEX64.test(id)) return c.json({ error: 'not_found' }, 404);
  return guarded(c, async (api) => (await api.getDocument(id as never)) ?? { error: 'not_found' });
});

queryApp.get('/api/documents/:id/pages', (c) => {
  const id = c.req.param('id');
  if (!HEX64.test(id)) return c.json({ error: 'not_found' }, 404);
  const from = int(c.req.query('from'), 0, 0, 99_999);
  return guarded(c, (api) => api.readPages(id as never, { fromIndex: from, toIndex: int(c.req.query('to'), from, from, from + 199), maxChars: int(c.req.query('maxChars'), 200_000, 1_000, 500_000) }));
});

queryApp.get('/api/documents/:id/annotations', (c) => {
  const id = c.req.param('id');
  if (!HEX64.test(id)) return c.json({ error: 'not_found' }, 404);
  const author = c.req.query('author');
  const cursor = c.req.query('cursor');
  return guarded(c, (api) =>
    api.getAnnotations(id as never, {
      ...(c.req.query('pageFrom') ? { pageFrom: int(c.req.query('pageFrom'), 0, 0, 99_999) } : {}),
      ...(c.req.query('pageTo') ? { pageTo: int(c.req.query('pageTo'), 99_999, 0, 99_999) } : {}),
      author: author === 'me' || author === 'claude' ? author : 'any',
      limit: int(c.req.query('limit'), 50, 1, 100),
      ...(cursor ? { cursor } : {}),
    }),
  );
});

queryApp.get('/api/notes', (c) => {
  const author = c.req.query('author');
  const cursor = c.req.query('cursor');
  return guarded(c, (api) => api.listNotes({ ...(author === 'me' || author === 'claude' ? { author } : {}), limit: int(c.req.query('limit'), 30, 1, 100), ...(cursor ? { cursor } : {}) }));
});

queryApp.get('/api/activity', (c) => guarded(c, (api) => api.recentActivity({ days: int(c.req.query('days'), 14, 1, 365), limit: int(c.req.query('limit'), 30, 1, 100) })));
