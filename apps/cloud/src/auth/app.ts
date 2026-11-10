// CL3: sign-in. The OAuth authorization server for our apps and for claude.ai, GitHub sign-in locked to the owner's numeric id,
// the web library's session cookie, the list of connections (/api/grants) and the owner's server switches.
//
//   /authorize                         GET: check the request, then consent (or straight to GitHub for the extension)
//                                      POST: the consent form
//   /oauth/github/callback             GitHub sends the browser back here (app sign-ins and the web login)
//   /oauth/token, /oauth/register      the library: code and refresh exchange, revocation, restricted registration
//   /.well-known/oauth-authorization-server              RFC 8414 metadata (with `iss` support, CIMD when available)
//   /.well-known/oauth-protected-resource[/api|/mcp]     RFC 9728 metadata for each resource
//   /login, /logout                    the web library's session
//   /api/grants, /api/grants/:id       cookie only: the signed-in apps, and revoking one
//   /api/server-settings               cookie only: Claude on/off (`mcp_enabled`) and "Claude can comment"
//   /app/oauth, /.well-known/assetlinks.json             the Android app's app-link sign-in

import { type AuthRequest, AuthorizationError, CimdFetchError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import type { AppEnv, Env } from '../env';
import { backToAppPage, claudeOffPage, consentPage, errorPage, notYourAccountPage, signInPage } from '../pages';
import { wiring } from '../seams';
import { audit } from './audit';
import { authenticate, clientAddress, mcpEnabled, requireAuth, tooManyRequests, withinLimit } from './authenticate';
import { GithubError, githubAuthorizeUrl, githubUserFromCode, isOwner, randomToken, s256 } from './github';
import { grantScopes, isWebRedirect, scopeLines } from './policy';
import {
  CHALLENGE_SCOPES,
  FIRST_PARTY_CLIENTS,
  type GrantMetadata,
  type GrantProps,
  type ResourceKind,
  authorizationServer,
  firstPartyKind,
  oauthApi,
  registerFirstPartyClients,
  resourceKindOf,
  resourceUrl,
} from './server';
import { WEB_STATE_PREFIX, beginWebLogin, createSession, csrfOk, endSession, finishWebLogin, getSession, safeNext, sameOrigin } from './session';

export { authenticate, requireAuth } from './authenticate';

// Every /api and /mcp area asks this one function (seams.ts).
wiring.authenticate = authenticate;

export const authApp = new Hono<AppEnv>();

const limitAuth = (env: Env, req: Request) => withinLimit(env.RL_AUTH, `auth:${clientAddress(req)}`);

// ─── The library's own endpoints ───────────────────────────────────────────────────────────────────────────────────────

async function library(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  if (!(await limitAuth(env, req))) return tooManyRequests();
  if (new URL(req.url).pathname === '/oauth/token') await registerFirstPartyClients(env);
  return authorizationServer(env).fetch(req, env, ctx);
}
for (const path of ['/oauth/token', '/oauth/register', '/.well-known/oauth-authorization-server']) authApp.all(path, (c) => library(c.env, c.req.raw, c.executionCtx as unknown as ExecutionContext));

function resourceMetadata(env: Env, kind: ResourceKind): Response {
  return new Response(
    JSON.stringify({
      resource: resourceUrl(env, kind),
      authorization_servers: [env.PUBLIC_URL],
      scopes_supported: CHALLENGE_SCOPES[kind],
      bearer_methods_supported: ['header'],
      resource_name: kind === 'mcp' ? 'My readings (sickofpdfs)' : 'sickofpdfs sync',
    }),
    { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' } },
  );
}
authApp.get('/.well-known/oauth-protected-resource/mcp', (c) => resourceMetadata(c.env, 'mcp'));
authApp.get('/.well-known/oauth-protected-resource/api', (c) => resourceMetadata(c.env, 'api'));
// Some clients look at the root first; the connector is the resource a third party would look for.
authApp.get('/.well-known/oauth-protected-resource', (c) => resourceMetadata(c.env, 'mcp'));

// ─── /authorize ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface UpstreamData {
  verifier: string;
  readOnly: boolean;
}

/** An error from the library: back to the client when its redirect address is proven, else a page. Never a redirect to an unchecked address. */
function authorizeFailure(e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectTo) return new Response(null, { status: 302, headers: { location: e.redirectTo } });
  if (e instanceof AuthorizationError) return errorPage('Sign-in did not work', 'This sign-in link is not valid, or it has expired.');
  if (e instanceof CimdFetchError) return errorPage('Sign-in did not work', 'The app that asked to sign in could not be checked.', 502);
  throw e;
}

async function toGithub(env: Env, request: AuthRequest, readOnly: boolean, headers?: Headers): Promise<Response> {
  const verifier = randomToken(48);
  const up = await oauthApi(env).beginUpstream(request, { data: { verifier, readOnly } satisfies UpstreamData, ...(headers ? { headers } : {}) });
  up.headers.set('location', githubAuthorizeUrl(env, up.state, await s256(verifier)));
  return new Response(null, { status: 302, headers: up.headers });
}

authApp.get('/authorize', async (c) => {
  const env = c.env;
  if (!(await limitAuth(env, c.req.raw))) return tooManyRequests();
  await registerFirstPartyClients(env);
  const oauth = oauthApi(env);
  let request: AuthRequest;
  try {
    request = await oauth.parseAuthRequest(c.req.raw);
  } catch (e) {
    return authorizeFailure(e);
  }
  const kind = resourceKindOf(env, request.resource);
  const fp = firstPartyKind(request.clientId);
  const deny = (description: string) => new Response(null, { status: 302, headers: { location: authorizationErrorRedirect(request, 'access_denied', description) } });
  if (kind === null) return deny('unknown resource');
  // Only our own apps may sync: a connector can never push, pull or download a PDF
  if (kind === 'api' && fp === null) return deny('this app may only use the Claude connector');
  if (kind === 'mcp' && !(await mcpEnabled(env))) return claudeOffPage();
  // A private-use address (com.sickofpdfs.reader:/oauth) belongs to the Android app alone
  if (!isWebRedirect(request.redirectUri) && request.clientId !== FIRST_PARTY_CLIENTS.android) {
    return errorPage('Sign-in did not work', 'This app asked to send access to an address this library does not allow.');
  }
  // The extension's address can only be opened by this extension, inside Chrome's sign-in window, so it skips the consent page
  if (fp === 'extension') return toGithub(env, request, false);

  let details;
  try {
    details = await oauth.describeConsent(request);
  } catch (e) {
    return authorizeFailure(e);
  }
  const consent = await oauth.beginConsent(request);
  return consentPage(
    {
      clientName: details.clientName.slice(0, 80),
      ...(details.clientDomain ? { publishedBy: details.clientDomain } : {}),
      ourApp: fp !== null,
      redirectHost: details.redirectHost,
      loopback: details.redirectIsLoopback,
      abilities: scopeLines(grantScopes(kind, request.scope, false)),
      handle: consent.handle,
      action: '/authorize',
      offerReadOnly: kind === 'mcp' && request.scope.includes('library:comment'),
    },
    consent.headers,
  );
});

authApp.post('/authorize', async (c) => {
  const env = c.env;
  if (!(await limitAuth(env, c.req.raw))) return tooManyRequests();
  if (!sameOrigin(env, c.req.raw)) return errorPage('Sign-in did not work', 'This form did not come from your library.', 403);
  const form = await c.req.raw.clone().formData().catch(() => null);
  const handle = form?.get('handle');
  const decision = form?.get('decision');
  if (typeof handle !== 'string' || handle === '') return errorPage('Sign-in did not work', 'This page has expired.');
  const oauth = oauthApi(env);
  try {
    if (decision !== 'approve' && decision !== 'read-only') {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(c.req.raw, handle);
    return await toGithub(env, approved.request, decision === 'read-only', approved.headers);
  } catch (e) {
    if (e instanceof AuthorizationError) return errorPage('Sign-in did not work', 'This page has expired, or it was opened in another browser.');
    throw e;
  }
});

// ─── GitHub's callback: both doors ─────────────────────────────────────────────────────────────────────────────────────

authApp.get('/oauth/github/callback', async (c) => {
  const env = c.env;
  if (!(await limitAuth(env, c.req.raw))) return tooManyRequests();
  const url = new URL(c.req.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code');
  if (state.startsWith(WEB_STATE_PREFIX)) return webCallback(env, c.req.raw, state, code, url.searchParams.has('error'));

  const oauth = oauthApi(env);
  let resumed;
  try {
    resumed = await oauth.finishUpstream<UpstreamData>(c.req.raw);
  } catch (e) {
    if (e instanceof AuthorizationError) return errorPage('Sign-in did not work', 'This sign-in has expired, or it was started in another browser.');
    throw e;
  }
  const { request, data, headers } = resumed;
  if (url.searchParams.has('error') || !code) {
    headers.set('location', authorizationErrorRedirect(request, 'access_denied', 'GitHub sign-in was cancelled'));
    return new Response(null, { status: 302, headers });
  }

  let user;
  try {
    user = await githubUserFromCode(env, code, data.verifier);
  } catch (e) {
    if (e instanceof GithubError) {
      console.warn(JSON.stringify({ event: 'github_failed', step: e.step }));
      return errorPage('Sign-in did not work', 'GitHub did not answer as expected.', 502);
    }
    throw e;
  }
  if (!isOwner(env, user.id)) {
    // No grant, no code: the client is never told anything it could use
    console.warn(JSON.stringify({ event: 'refused_not_owner', door: 'oauth' }));
    const refused = notYourAccountPage(user.login);
    for (const v of headers.getSetCookie()) refused.headers.append('set-cookie', v);
    return refused;
  }

  const kind = resourceKindOf(env, request.resource) ?? 'mcp';
  const fp = firstPartyKind(request.clientId);
  const client = await oauth.lookupClient(request.clientId).catch(() => null);
  const clientName = (client?.clientName ?? new URL(request.redirectUri).host ?? request.clientId).slice(0, 80);
  const { redirectTo } = await oauth.completeAuthorization({
    request,
    userId: user.id,
    metadata: { clientName, resource: kind, firstParty: fp } satisfies GrantMetadata,
    scope: grantScopes(kind, request.scope, data.readOnly),
    props: { uid: user.id, login: user.login, resource: kind } satisfies GrantProps,
    // Our apps run on several computers and phones at once with one client id: a new sign-in must not sign the others out.
    // A connector (claude.ai) replaces its own earlier sign-in.
    revokeExistingGrants: fp === null,
  });
  await audit(env, { actor: 'owner', clientId: request.clientId, action: 'grant.create', target: kind });
  headers.set('location', redirectTo);
  return new Response(null, { status: 302, headers });
});

// ─── The web library's session ─────────────────────────────────────────────────────────────────────────────────────────

authApp.get('/login', async (c) => {
  const next = safeNext(c.req.query('next'));
  const s = await getSession(c.env, c.req.raw);
  if (s && isOwner(c.env, s.uid)) return c.redirect(next, 302);
  return signInPage('/login', next);
});

authApp.post('/login', async (c) => {
  const env = c.env;
  if (!(await limitAuth(env, c.req.raw))) return tooManyRequests();
  if (!sameOrigin(env, c.req.raw)) return errorPage('Sign-in did not work', 'This form did not come from your library.', 403);
  const form = await c.req.raw.clone().formData().catch(() => null);
  const nextField = form?.get('next');
  const { state, verifier, cookie } = await beginWebLogin(env, typeof nextField === 'string' ? nextField : '/');
  return new Response(null, { status: 302, headers: { location: githubAuthorizeUrl(env, state, await s256(verifier)), 'set-cookie': cookie, 'cache-control': 'no-store' } });
});

async function webCallback(env: Env, req: Request, state: string, code: string | null, cancelled: boolean): Promise<Response> {
  const login = await finishWebLogin(env, req, state);
  if (!login) return errorPage('Sign-in did not work', 'This sign-in has expired, or it was started in another browser.');
  if (cancelled || !code) return new Response(null, { status: 302, headers: { location: '/login', 'set-cookie': login.clear } });
  let user;
  try {
    user = await githubUserFromCode(env, code, login.verifier);
  } catch (e) {
    if (e instanceof GithubError) return errorPage('Sign-in did not work', 'GitHub did not answer as expected.', 502);
    throw e;
  }
  if (!isOwner(env, user.id)) {
    console.warn(JSON.stringify({ event: 'refused_not_owner', door: 'web' }));
    const refused = notYourAccountPage(user.login);
    refused.headers.append('set-cookie', login.clear);
    return refused;
  }
  // Each browser is its own sync device, so two browsers editing one note keep both texts
  const device = `web-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  await env.META.prepare("INSERT INTO device (id, name, kind, created_at) VALUES (?, 'Web library', 'web', ?) ON CONFLICT(id) DO NOTHING").bind(device, Date.now()).run();
  const { cookies } = await createSession(env, { uid: user.id, login: user.login }, device);
  await audit(env, { actor: 'owner', clientId: null, action: 'session.create', target: 'web' });
  const h = new Headers({ location: login.next, 'cache-control': 'no-store' });
  h.append('set-cookie', login.clear);
  for (const k of cookies) h.append('set-cookie', k);
  return new Response(null, { status: 302, headers: h });
}

authApp.post('/logout', async (c) => {
  const env = c.env;
  const s = await getSession(env, c.req.raw);
  if (s) {
    const form = await c.req.raw.clone().formData().catch(() => null);
    const token = form?.get('csrf');
    if (!csrfOk(env, c.req.raw, s, typeof token === 'string' ? token : null)) return c.json({ error: 'csrf', message: 'Reload the page and try again.' }, 403);
  }
  const h = new Headers({ location: '/login', 'cache-control': 'no-store' });
  for (const k of await endSession(env, c.req.raw)) h.append('set-cookie', k);
  return new Response(null, { status: 302, headers: h });
});

// ─── Connections (cookie only) ─────────────────────────────────────────────────────────────────────────────────────────

authApp.get('/api/grants', requireAuth({ cookieOnly: true }), async (c) => {
  const auth = c.get('auth');
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  const oauth = oauthApi(c.env);
  const grants: Awaited<ReturnType<typeof oauth.listUserGrants>>['items'] = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(auth.uid, { limit: 100, ...(cursor ? { cursor } : {}) });
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor && grants.length < 500);
  const devices = new Map<string, { id: string; name: string; last_seen_at: number | null }>();
  const ids = grants.map((g) => g.id);
  const reads: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    reads.push(c.env.META.prepare(`SELECT id, name, grant_id, last_seen_at FROM device WHERE grant_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk));
  }
  if (reads.length) for (const r of await c.env.META.batch<{ id: string; name: string; grant_id: string; last_seen_at: number | null }>(reads)) for (const d of r.results) devices.set(d.grant_id, d);
  return c.json(
    {
      grants: grants.map((g) => {
        const m = (g.metadata ?? {}) as Partial<GrantMetadata>;
        const d = devices.get(g.id);
        return {
          id: g.id,
          clientId: g.clientId,
          clientName: m.clientName ?? g.clientId,
          kind: m.firstParty ?? (m.resource === 'mcp' ? 'connector' : 'other'),
          resource: m.resource ?? null,
          scopes: g.scope,
          createdAt: g.createdAt * 1000,
          expiresAt: g.expiresAt ? g.expiresAt * 1000 : null,
          device: d ? { id: d.id, name: d.name, lastSeenAt: d.last_seen_at } : null,
        };
      }),
    },
    200,
    { 'cache-control': 'no-store' },
  );
});

authApp.delete('/api/grants/:id', requireAuth({ cookieOnly: true }), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return c.json({ error: 'bad_id' }, 400);
  await oauthApi(c.env).revokeGrant(id, auth.uid);
  await c.env.META.prepare('UPDATE device SET grant_id = NULL WHERE grant_id = ?').bind(id).run();
  await audit(c.env, { actor: 'owner', clientId: null, action: 'grant.revoke', target: null });
  return c.json({ ok: true }, 200, { 'cache-control': 'no-store' });
});

// ─── The owner's switches (cookie only) ────────────────────────────────────────────────────────────────────────────────

const SWITCHES = { mcpEnabled: 'mcp_enabled', claudeCanComment: 'claude_can_comment' } as const;

authApp.get('/api/server-settings', requireAuth({ cookieOnly: true }), async (c) => {
  const r = await c.env.META.prepare("SELECT key, value FROM setting WHERE key IN ('mcp_enabled','claude_can_comment')").all<{ key: string; value: string }>();
  const v = new Map(r.results.map((x) => [x.key, x.value]));
  return c.json({ mcpEnabled: v.get('mcp_enabled') !== 'false', claudeCanComment: v.get('claude_can_comment') !== 'false' }, 200, { 'cache-control': 'no-store' });
});

authApp.put('/api/server-settings', requireAuth({ cookieOnly: true }), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'bad_body' }, 400);
  const writes: D1PreparedStatement[] = [];
  for (const [field, key] of Object.entries(SWITCHES)) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return c.json({ error: 'bad_body', message: `${field} must be true or false` }, 400);
    writes.push(c.env.META.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(v)));
    writes.push(c.env.META.prepare("INSERT INTO audit (at, actor, client_id, action, target) VALUES (?, 'owner', NULL, 'setting.change', ?)").bind(Date.now(), key));
  }
  if (writes.length) await c.env.META.batch(writes);
  return c.json({ ok: true }, 200, { 'cache-control': 'no-store' });
});

// ─── The Android app's app link ───────────────────────────────────────────────────────────────────────────────────────

authApp.get('/app/oauth', () => backToAppPage());

authApp.get('/.well-known/assetlinks.json', (c) => {
  const fp = (c.env.ANDROID_CERT_SHA256 ?? '').trim();
  if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fp)) return c.json({ error: 'not_found' }, 404);
  return c.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'com.sickofpdfs.reader', sha256_cert_fingerprints: [fp] } }], 200, { 'cache-control': 'public, max-age=3600' });
});
