// `authenticate(req, env)`: who is calling /api or /mcp, checked on every request (CL3, contracts §7 "Auth").
//
//   /mcp   a bearer token for the connector resource, from the owner. Device `claude`. Answers 503 while the owner has
//          turned Claude off (the kill switch, `setting.mcp_enabled`).
//   /api   a bearer token for the sync resource, from the owner, whose device is the one registered to that sign-in; or the web
//          library's session cookie, where every change also needs our Origin and the CSRF token.
//
// A token for one resource never works on the other (the library checks the audience). The owner's GitHub id is checked again
// here, so changing ALLOWED_GITHUB_ID shuts every older token out at once. Every request is rate limited by address first.

import { insufficientScope } from '@cloudflare/workers-oauth-provider';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from '../env';
import type { AuthContext } from '../seams';
import { isOwner } from './github';
import { CHALLENGE_SCOPES, type GrantProps, type ResourceKind, type Scope, authorizationServer, resourceMetadataUrl, resourceUrl } from './server';
import { csrfOk, getSession, isUnsafe } from './session';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...NO_STORE, ...headers } });

/** The caller's address, for rate limits only. Never stored. */
export function clientAddress(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? 'local';
}

/** One step of a rate limit. A binding that fails lets the request through (the limit protects; it must never lock the owner out). */
export async function withinLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

export const tooManyRequests = (): Response => json(429, { error: 'rate_limited', message: 'Too many requests. Wait a minute and try again.' }, { 'retry-after': '60' });

/** 401 with the RFC 9728 challenge: where the resource's metadata is and which scopes to ask for. */
export function unauthorized(env: Env, kind: ResourceKind, error?: 'invalid_token', description?: string): Response {
  let challenge = `Bearer realm="OAuth", resource_metadata="${resourceMetadataUrl(env, kind)}"`;
  if (error) challenge += `, error="${error}"`;
  challenge += `, scope="${CHALLENGE_SCOPES[kind].join(' ')}"`;
  if (description) challenge += `, error_description="${description.replace(/["\\]/g, '')}"`;
  return json(401, { error: error ?? 'unauthorized', message: description ?? 'Sign in first.' }, { 'www-authenticate': challenge });
}

/** Scopes that include others: on the sync API, `sync` reads the library too; on the connector, commenting includes reading. */
export function effectiveScopes(kind: ResourceKind, scopes: readonly string[]): string[] {
  const out = new Set(scopes);
  if (kind === 'api' && out.has('sync')) out.add('library:read');
  if (kind === 'mcp' && out.has('library:comment')) out.add('library:read');
  return [...out];
}

/** The kill switch. Off means /mcp answers 503 and claude.ai cannot sign in again. Anything but 'false' is on. */
export async function mcpEnabled(env: Env): Promise<boolean> {
  const row = await env.META.prepare("SELECT value FROM setting WHERE key = 'mcp_enabled'").first<{ value: string }>();
  return row?.value !== 'false';
}

function bearerOf(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+([\x21-\x7e]{1,4096})$/i.exec(h.trim());
  return m?.[1] ?? null;
}

function resourceOfPath(pathname: string): ResourceKind | null {
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) return 'mcp';
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'api';
  return null;
}

/**
 * Who is calling, or the Response to send instead (401, 403, 429 or 503). Never throws for a bad request.
 * The resource comes from the path: /mcp is the connector, /api/* the sync API and the library reads.
 */
export async function authenticate(req: Request, env: Env): Promise<AuthContext | Response> {
  const kind = resourceOfPath(new URL(req.url).pathname);
  if (kind === null) return json(404, { error: 'not_found' });
  if (!(await withinLimit(kind === 'mcp' ? env.RL_MCP : env.RL_API, `${kind}:${clientAddress(req)}`))) return tooManyRequests();

  if (kind === 'mcp' && !(await mcpEnabled(env))) {
    return json(503, { error: 'mcp_disabled', message: 'Claude\'s access to your library is turned off. Turn it on in your library\'s Settings.' }, { 'retry-after': '3600' });
  }

  const token = bearerOf(req);
  if (token !== null) {
    let v;
    try {
      v = await authorizationServer(env).validateToken<GrantProps>(resourceUrl(env, kind), token, env);
    } catch (e) {
      console.error(JSON.stringify({ event: 'token_check_failed', error: e instanceof Error ? e.name : 'unknown' }));
      return json(503, { error: 'unavailable', message: 'Sign-in could not be checked. Try again soon.' }, { 'retry-after': '5' });
    }
    if (v === null) return unauthorized(env, kind, 'invalid_token', 'The token is not valid here');
    if (!isOwner(env, v.props?.uid) || v.userId !== v.props?.uid) return unauthorized(env, kind, 'invalid_token', 'This sign-in is not the owner');
    let device: string | null;
    if (kind === 'mcp') device = 'claude';
    else {
      // A validated token is `<userId>:<grantId>:<secret>`; the device belongs to the grant (POST /api/devices binds it)
      const grantId = token.split(':')[1] ?? '';
      const row = await env.META.prepare('SELECT id FROM device WHERE grant_id = ?').bind(grantId).first<{ id: string }>();
      device = row?.id ?? null;
    }
    return { kind: 'bearer', uid: v.props.uid, clientId: v.clientId, scopes: effectiveScopes(kind, v.scope), device };
  }

  // A web sign-in cookie never works on /mcp: a page in the browser could send it along
  if (kind === 'mcp' && (await getSession(env, req))) return json(403, { error: 'insufficient_scope', message: 'The connector needs its own sign-in.' });
  if (kind === 'api') {
    const session = await getSession(env, req);
    if (session) {
      if (!isOwner(env, session.uid)) return unauthorized(env, kind, 'invalid_token', 'This sign-in is not the owner');
      if (isUnsafe(req.method) && !csrfOk(env, req, session)) return json(403, { error: 'csrf', message: 'This change did not come from your library page. Reload the page and try again.' });
      return { kind: 'cookie', uid: session.uid, clientId: null, scopes: ['library:read', 'sync'], device: session.device };
    }
  }
  return unauthorized(env, kind);
}

/** 403 naming every scope the operation needs (RFC 6750 §3.1), so a client can sign in again for them. */
export function insufficient(env: Env, auth: AuthContext, kind: ResourceKind, needed: Scope[]): Response {
  if (auth.kind === 'cookie') return json(403, { error: 'insufficient_scope', message: 'This page may not do that.' });
  return insufficientScope({ token: '', audience: resourceUrl(env, kind), scope: auth.scopes }, needed);
}

export interface RequireAuthOptions {
  /** Every one of these is needed (after `effectiveScopes`). */
  scopes?: Scope[];
  /** Only the web library's session cookie, never a bearer token (`/api/grants`, the server switches). */
  cookieOnly?: boolean;
  /** The web library's session cookie is not accepted (default: accepted on /api). */
  bearerOnly?: boolean;
}

/** Hono middleware: runs `authenticate`, applies the options, and puts the result in `c.get('auth')`. */
export function requireAuth(o: RequireAuthOptions = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (o.cookieOnly && c.req.header('authorization')) return c.json({ error: 'cookie_only', message: 'Use the web library for this.' }, 403);
    const auth = await authenticate(c.req.raw, c.env);
    if (auth instanceof Response) return auth;
    if (o.cookieOnly && auth.kind !== 'cookie') return c.json({ error: 'cookie_only', message: 'Use the web library for this.' }, 403);
    if (o.bearerOnly && auth.kind !== 'bearer') return unauthorized(c.env, 'api');
    const kind = resourceOfPath(new URL(c.req.url).pathname) ?? 'api';
    if (o.scopes && !o.scopes.every((s) => auth.scopes.includes(s))) return insufficient(c.env, auth, kind, o.scopes);
    c.set('auth', auth);
    await next();
  };
}
