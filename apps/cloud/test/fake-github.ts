// Fakes for everything the Worker would otherwise reach on the internet while signing in: GitHub, and the pages that describe an
// OAuth client (CIMD). Pure functions over a plain request and response, with no imports, so the same code runs in three places:
//   - the tests (as Miniflare's outbound service: the Worker's `fetch` never leaves the machine),
//   - `pnpm -C apps/cloud dev:test` (behind a real HTTP port, for `wrangler dev` and a headless browser leg),
//   - the harness (to read what was asked).
// Erasable TypeScript only, so Node can run it without a build.
//
// "Who signs in" is chosen by a query parameter on the GitHub authorize URL: `as=owner` or `as=stranger`. Without it the fake shows
// two links, so a person can click through in a browser.

export const FAKE_OWNER = { id: 4242001, login: 'the-owner', name: 'The Owner' } as const;
export const FAKE_STRANGER = { id: 4242002, login: 'a-stranger', name: 'A Stranger' } as const;
export type FakeWho = 'owner' | 'stranger';

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
export interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const json = (status: number, value: unknown): FakeResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const html = (status: number, body: string): FakeResponse => ({ status, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function formOrJson(req: FakeRequest, url: URL): URLSearchParams {
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (type.includes('application/json')) {
    try {
      const o = JSON.parse(req.body || '{}') as Record<string, unknown>;
      return new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)] as [string, string]));
    } catch {
      return new URLSearchParams();
    }
  }
  const p = new URLSearchParams(req.body);
  for (const [k, v] of url.searchParams) if (!p.has(k)) p.set(k, v);
  return p;
}

export interface FakeGithubOptions {
  clientId?: string;
  clientSecret?: string;
}

export interface FakeGithub {
  handle(req: FakeRequest): FakeResponse;
  /** What the Worker asked for, in order: "GET /user", "POST /login/oauth/access_token", ... */
  readonly calls: string[];
  reset(): void;
}

/** GitHub's three endpoints that sign-in uses: authorize, access_token and `GET /user`. Codes and tokens are single-purpose and unguessable by design only in the real thing; here they are counters. */
export function createFakeGithub(opts: FakeGithubOptions = {}): FakeGithub {
  const clientId = opts.clientId ?? 'fake-client-id';
  const clientSecret = opts.clientSecret ?? 'fake-secret';
  const calls: string[] = [];
  let codes = new Map<string, FakeWho>();
  let tokens = new Map<string, FakeWho>();
  let n = 0;

  const user = (who: FakeWho) => (who === 'owner' ? FAKE_OWNER : FAKE_STRANGER);

  return {
    calls,
    reset() {
      calls.length = 0;
      codes = new Map();
      tokens = new Map();
      n = 0;
    },
    handle(req) {
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}`);

      if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
        const redirect = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state') ?? '';
        if (url.searchParams.get('client_id') !== clientId) return json(404, { error: 'unknown client_id' });
        if (!redirect || !/^https?:\/\//.test(redirect)) return json(422, { error: 'redirect_uri must be http(s)' });
        const as = url.searchParams.get('as');
        if (as === 'owner' || as === 'stranger') {
          const code = `${as}.${++n}`;
          codes.set(code, as);
          const back = new URL(redirect);
          back.searchParams.set('code', code);
          back.searchParams.set('state', state);
          return { status: 302, headers: { location: back.toString() }, body: '' };
        }
        const link = (who: FakeWho, label: string) => {
          const u = new URL(url);
          u.searchParams.set('as', who);
          return `<p><a href="${escape(u.toString())}">${label}</a></p>`;
        };
        return html(200, `<!doctype html><title>Fake GitHub</title><h1>Fake GitHub sign-in</h1>${link('owner', 'Sign in as the owner')}${link('stranger', 'Sign in as a stranger')}`);
      }

      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const p = formOrJson(req, url);
        const who = codes.get(p.get('code') ?? '');
        const wantsJson = (req.headers['accept'] ?? '').includes('json');
        const reply = (status: number, o: Record<string, string>): FakeResponse =>
          wantsJson ? json(status, o) : { status, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() };
        if (p.get('client_id') !== clientId || p.get('client_secret') !== clientSecret) return reply(200, { error: 'incorrect_client_credentials' });
        if (!who) return reply(200, { error: 'bad_verification_code' });
        codes.delete(p.get('code') ?? ''); // a code works once
        const token = `ghu_fake_${who}_${++n}`;
        tokens.set(token, who);
        return reply(200, { access_token: token, token_type: 'bearer', scope: '' });
      }

      if (req.method === 'GET' && url.pathname === '/user') {
        const auth = req.headers['authorization'] ?? '';
        const who = tokens.get(auth.replace(/^(Bearer|token)\s+/i, ''));
        if (!who) return json(401, { message: 'Bad credentials' });
        const u = user(who);
        return json(200, { id: u.id, login: u.login, name: u.name, type: 'User' });
      }

      return json(404, { message: 'Not Found' });
    },
  };
}

// ─── Client metadata documents (CIMD) ──────────────────────────────────────────────────────────────────────────────────────

export interface CimdDocument {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

export interface FakeCimdHost {
  /** Answers a request for a client metadata document, or null when the URL is not one this host serves. */
  handle(req: FakeRequest): FakeResponse | null;
  /** Serve one more client. `client_id` must be the URL the document is served from. */
  add(doc: CimdDocument): void;
  readonly calls: string[];
}

/**
 * The two published identities claude.ai and Claude Code use, at their real addresses, plus any client a test adds. Every
 * address under `/clients/` on one of `clientHosts` describes itself (its own address is its client_id).
 */
export function createFakeCimdHost(clientHosts: readonly string[] = ['client.fake']): FakeCimdHost {
  const docs = new Map<string, CimdDocument>();
  const calls: string[] = [];
  const base = { grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  const add = (doc: CimdDocument) => void docs.set(doc.client_id, { ...base, ...doc });
  add({
    client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
  });
  add({
    client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  });
  return {
    calls,
    add,
    handle(req) {
      if (req.method !== 'GET') return null;
      const url = new URL(req.url);
      if (clientHosts.includes(url.host) && url.pathname.startsWith('/clients/')) {
        // a client that describes itself; ?redirect_uri=... sets where it signs in to
        const redirect = url.searchParams.get('redirect_uri') ?? `${url.protocol}//${url.host}/callback`;
        calls.push(req.url);
        return json(200, { ...base, client_id: req.url, client_name: `Test client ${url.pathname}`, redirect_uris: [redirect] });
      }
      const doc = docs.get(req.url.split('#')[0] ?? req.url);
      if (!doc) return null;
      calls.push(req.url);
      return json(200, doc);
    },
  };
}

// ─── The whole fake internet ───────────────────────────────────────────────────────────────────────────────────────────────

export interface FakeInternet {
  github: FakeGithub;
  cimd: FakeCimdHost;
  /** Route a request by host. Anything that is not a fake answers 502, so a test can never reach the real internet. */
  handle(req: FakeRequest): FakeResponse;
  /** Hosts that are served. */
  readonly githubHost: string;
}

/** GitHub lives at `https://github.fake` (login and API on one host); claude.ai's client documents at their real address; test clients at `https://client.fake/clients/<name>` (auto-described). */
export function createFakeInternet(opts: FakeGithubOptions & { githubHost?: string; clientHosts?: readonly string[] } = {}): FakeInternet {
  const githubHost = opts.githubHost ?? 'github.fake';
  const github = createFakeGithub(opts);
  const cimd = createFakeCimdHost(opts.clientHosts);
  return {
    github,
    cimd,
    githubHost,
    handle(req) {
      const host = new URL(req.url).host;
      const doc = cimd.handle(req);
      if (doc) return doc;
      if (host === githubHost) return github.handle(req);
      return json(502, { error: 'blocked by the test harness: the Worker may only reach the fakes', url: req.url });
    },
  };
}
