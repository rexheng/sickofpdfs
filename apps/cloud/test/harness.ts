// The local test harness for the Worker, inside workerd. Imported by tests (`./harness`).
//
//   call(path, init)       one request to the Worker, exactly as a browser or the extension would send it
//   limitedEnv()           the bindings with Cloudflare's free-plan D1 limits on (100 bound parameters, 50 queries a request)
//   resetState()           empties every table, the bucket and the KV, back to the freshly migrated state
//   asOwner(scopes)        signs in through the real redirects (fake GitHub says "the owner") and returns a ready session
//   signIn({ as })         the same, for "a stranger" or to look at a refusal
//   cimdClient(name)       the address of a client that describes itself (the fake CIMD host serves it)
//
// There is no test-only way to mint a token: sign-in follows the real /authorize, GitHub, callback and /oauth/token steps against
// the fake GitHub, so a test proves the same doors the owner walks through. Until CL3 builds those routes, `asOwner` throws
// "sign-in is not built yet"; everything else here works from the start.
import { env, exports } from 'cloudflare:workers';
import { type Env, QueryBudget, textShards, withD1Limits } from '../src/env';
import { FAKE_OWNER, FAKE_STRANGER, type FakeWho } from './fake-github';

export { FAKE_OWNER, FAKE_STRANGER };
export { D1LimitError, QueryBudget, limitD1, withD1Limits } from '../src/env';

export const PUBLIC_URL: string = env.PUBLIC_URL;

/** One request to the Worker. A path ('/api/health') is resolved against PUBLIC_URL. Redirects are not followed. */
export function call(path: string | Request, init?: RequestInit): Promise<Response> {
  const req = typeof path === 'string' ? new Request(new URL(path, PUBLIC_URL), { redirect: 'manual', ...init }) : path;
  return (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default.fetch(req);
}

/** The Worker's bindings with the D1 limits on and a fresh query budget. For tests that call handlers directly. */
export function limitedEnv(budget: QueryBudget = new QueryBudget()): Env {
  return withD1Limits(env, budget);
}

const META_TABLES = ['comments', 'threads', 'marks', 'history', 'locations', 'aliases', 'documents', 'applied_entry', 'blob_upload', 'audit', 'usage_day', 'doc_text', 'forgotten'];

/** Back to the state a fresh migration leaves: empty tables, the `claude` device, default settings, counter at 0, no files, no KV. */
export async function resetState(): Promise<void> {
  const e = env as unknown as Env;
  await e.META.batch([
    ...META_TABLES.map((t) => e.META.prepare(`DELETE FROM ${t}`)),
    e.META.prepare("DELETE FROM device WHERE id <> 'claude'"),
    e.META.prepare('DELETE FROM setting'),
    e.META.prepare("INSERT INTO setting (key, value) VALUES ('mcp_enabled', 'true'), ('claude_can_comment', 'true')"),
    e.META.prepare('UPDATE sync_counter SET seq = 0'),
  ]);
  for (const shard of textShards(e)) await shard.batch([shard.prepare('DELETE FROM page'), shard.prepare('DELETE FROM shard_doc')]);
  for (let cursor: string | undefined; ; ) {
    const page = await e.BLOBS.list(cursor ? { cursor } : {});
    if (page.objects.length) await e.BLOBS.delete(page.objects.map((o) => o.key));
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  for (let cursor: string | undefined; ; ) {
    const page = await e.OAUTH_KV.list(cursor ? { cursor } : {});
    await Promise.all(page.keys.map((k) => e.OAUTH_KV.delete(k.name)));
    if (page.list_complete) break;
    cursor = page.cursor;
  }
}

// ─── Sign in ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A client that describes itself at this address (CIMD). The fake host serves every address under https://client.fake. */
export function cimdClient(name = 'test', redirectUri = 'https://client.fake/callback'): { clientId: string; redirectUri: string } {
  return { clientId: `https://client.fake/clients/${name}.json?redirect_uri=${encodeURIComponent(redirectUri)}`, redirectUri };
}

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const random = (n = 32): string => b64url(crypto.getRandomValues(new Uint8Array(n)));

class Jar {
  private cookies = new Map<string, string>();
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/;\s*max-age=0\b/i.test(line) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

export interface Session {
  who: FakeWho;
  clientId: string;
  scopes: string[];
  accessToken: string;
  refreshToken: string | null;
  /** The audience this token is for: `${PUBLIC_URL}/api` or `${PUBLIC_URL}/mcp`. */
  resource: string;
  /** A request to the Worker with this session's bearer token. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export type SignInResult = { ok: true; session: Session } | { ok: false; response: Response; why: string };

export interface SignInOptions {
  scopes: string[];
  /** Who GitHub says is signing in. Default the owner. */
  as?: FakeWho;
  /** Which door the token is for. Default the sync API. */
  resource?: 'api' | 'mcp';
  client?: { clientId: string; redirectUri: string };
}

/** Walks the real sign-in: /authorize, the consent page, GitHub (fake), the callback, then /oauth/token with PKCE. */
export async function signIn(opts: SignInOptions): Promise<SignInResult> {
  const who = opts.as ?? 'owner';
  const client = opts.client ?? cimdClient();
  const resource = `${PUBLIC_URL}/${opts.resource ?? 'api'}`;
  const verifier = random(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = random(16);
  const jar = new Jar();

  const authorize = new URL('/authorize', PUBLIC_URL);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: opts.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
  }).toString();

  let req: Request = new Request(authorize, { redirect: 'manual' });
  let code: string | null = null;
  for (let hop = 0; hop < 12 && code === null; hop++) {
    const isWorker = new URL(req.url).origin === new URL(PUBLIC_URL).origin;
    if (isWorker && jar.header()) req.headers.set('cookie', jar.header());
    const res = isWorker ? await call(req) : await fetch(req);
    if (isWorker) jar.take(res);

    if (res.status === 501 && isWorker) throw new Error('sign-in is not built yet (CL3 owns /authorize and /oauth/*)');
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get('location') ?? '', req.url);
      if (`${next.origin}${next.pathname}` === client.redirectUri) {
        if (next.searchParams.get('state') !== state) return { ok: false, response: res, why: 'state came back different' };
        code = next.searchParams.get('code');
        if (code === null) return { ok: false, response: res, why: `the client was sent back with ${next.searchParams.get('error') ?? 'no code'}` };
        break;
      }
      if (next.host === new URL(env.GITHUB_BASE_URL ?? '').host) next.searchParams.set('as', who); // GitHub's "who is signing in"
      req = new Request(next, { redirect: 'manual' });
      continue;
    }
    const body = await res.text();
    const form = /<form[^>]*method=["']?post["']?[^>]*>([\s\S]*?)<\/form>/i.exec(body);
    if (res.status === 200 && form) {
      // the consent page: submit its hidden fields and press the first button (the approve button)
      const action = new URL(/action=["']([^"']*)["']/i.exec(form[0])?.[1] ?? req.url, req.url);
      const fields = new URLSearchParams();
      for (const m of form[1].matchAll(/<input[^>]*type=["']hidden["'][^>]*>/gi)) {
        const name = /name=["']([^"']*)["']/i.exec(m[0])?.[1];
        const value = /value=["']([^"']*)["']/i.exec(m[0])?.[1] ?? '';
        if (name) fields.set(name, value.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
      }
      const button = /<button[^>]*name=["']([^"']*)["'][^>]*value=["']([^"']*)["']/i.exec(form[1]);
      if (button) fields.set(button[1], button[2]);
      req = new Request(action, { method: 'POST', body: fields, redirect: 'manual', headers: { origin: PUBLIC_URL } });
      continue;
    }
    return { ok: false, response: new Response(body, res), why: `stopped at ${res.status} on ${new URL(req.url).pathname}` };
  }
  if (code === null) return { ok: false, response: new Response('too many redirects', { status: 508 }), why: 'too many redirects' };

  const tokenRes = await call('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUri, client_id: client.clientId, code_verifier: verifier, resource }),
  });
  if (!tokenRes.ok) return { ok: false, response: tokenRes, why: `token exchange answered ${tokenRes.status}` };
  const t = await tokenRes.json<{ access_token: string; refresh_token?: string; scope?: string }>();
  const session: Session = {
    who,
    clientId: client.clientId,
    scopes: (t.scope ?? opts.scopes.join(' ')).split(' ').filter(Boolean),
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    resource,
    fetch: (path, init) => call(path, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${t.access_token}` } }),
  };
  return { ok: true, session };
}

/** A ready, signed-in session for the owner. Throws if sign-in does not work. */
export async function asOwner(scopes: string[], opts: Omit<SignInOptions, 'scopes' | 'as'> = {}): Promise<Session> {
  const r = await signIn({ ...opts, scopes, as: 'owner' });
  if (!r.ok) throw new Error(`could not sign in as the owner: ${r.why}`);
  return r.session;
}

/** Signs in as some other GitHub account. The Worker should refuse; `response` is what the person would see. */
export async function asStranger(scopes: string[], opts: Omit<SignInOptions, 'scopes' | 'as'> = {}): Promise<SignInResult> {
  return signIn({ ...opts, scopes, as: 'stranger' });
}
