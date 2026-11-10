// The web library's sign-in: a `__Host-sess` cookie that names a session kept in KV. The cookie holds a random id; KV holds only
// the id's SHA-256, so reading KV gives no way in. Every change (POST, PUT, PATCH, DELETE) must also come from our own origin
// and carry the session's CSRF token in `x-csrf-token`, which the page reads from the `__Host-csrf` cookie (double submit).

import type { Env } from '../env';
import { constantTimeEqual, randomToken, sha256Hex } from './github';

export const SESSION_COOKIE = '__Host-sess';
export const CSRF_COOKIE = '__Host-csrf';
export const CSRF_HEADER = 'x-csrf-token';
const LOGIN_COOKIE = '__Host-login';

const SESSION_DAYS = 30;
const LOGIN_SECONDS = 600;

export interface WebSession {
  uid: string;
  login: string;
  /** The sync device this browser writes as (`web-…`). */
  device: string;
  csrf: string;
  createdAt: number;
  expiresAt: number;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number, o: { httpOnly: boolean; sameSite: 'Lax' | 'Strict' }): string {
  return `${name}=${value}; Path=/; Secure; ${o.httpOnly ? 'HttpOnly; ' : ''}SameSite=${o.sameSite}; Max-Age=${maxAge}`;
}

const sessionKey = async (sid: string) => `sop:sess:${await sha256Hex(sid)}`;

/** Starts a session for the owner and returns the cookies to set. */
export async function createSession(env: Env, user: { uid: string; login: string }, device: string): Promise<{ cookies: string[]; session: WebSession }> {
  const sid = randomToken(32);
  const now = Date.now();
  const session: WebSession = { uid: user.uid, login: user.login, device, csrf: randomToken(24), createdAt: now, expiresAt: now + SESSION_DAYS * 86_400_000 };
  await env.OAUTH_KV.put(await sessionKey(sid), JSON.stringify(session), { expirationTtl: SESSION_DAYS * 86_400 });
  return {
    session,
    cookies: [
      cookie(SESSION_COOKIE, sid, SESSION_DAYS * 86_400, { httpOnly: true, sameSite: 'Lax' }),
      // readable by the page, so it can send it back in x-csrf-token; useless to another site, which cannot read it
      cookie(CSRF_COOKIE, session.csrf, SESSION_DAYS * 86_400, { httpOnly: false, sameSite: 'Strict' }),
    ],
  };
}

export async function getSession(env: Env, req: Request): Promise<WebSession | null> {
  const sid = readCookie(req, SESSION_COOKIE);
  if (!sid || !/^[A-Za-z0-9_-]{20,100}$/.test(sid)) return null;
  const s = await env.OAUTH_KV.get<WebSession>(await sessionKey(sid), 'json');
  if (!s || s.expiresAt < Date.now()) return null;
  return s;
}

export async function endSession(env: Env, req: Request): Promise<string[]> {
  const sid = readCookie(req, SESSION_COOKIE);
  if (sid && /^[A-Za-z0-9_-]{20,100}$/.test(sid)) await env.OAUTH_KV.delete(await sessionKey(sid));
  return [cookie(SESSION_COOKIE, '', 0, { httpOnly: true, sameSite: 'Lax' }), cookie(CSRF_COOKIE, '', 0, { httpOnly: false, sameSite: 'Strict' })];
}

/** Methods that change something. They need our Origin and the CSRF token. */
export const isUnsafe = (method: string): boolean => !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

/** The request comes from a page on our own address (browsers send `Origin` on every POST, PUT, PATCH and DELETE). */
export function sameOrigin(env: Env, req: Request): boolean {
  const origin = req.headers.get('origin');
  return origin !== null && origin === new URL(env.PUBLIC_URL).origin;
}

/** A change made with the session cookie: our own origin, and the CSRF token in the header or (for plain forms) the body field. */
export function csrfOk(env: Env, req: Request, session: WebSession, formToken?: string | null): boolean {
  if (!sameOrigin(env, req)) return false;
  const sent = req.headers.get(CSRF_HEADER) ?? formToken ?? '';
  return sent !== '' && constantTimeEqual(sent, session.csrf);
}

// ─── The short-lived login state for the web library (state and PKCE verifier between /login and GitHub's callback) ─────────

/** The prefix that tells the GitHub callback this state belongs to a web login, not to an app's OAuth sign-in. */
export const WEB_STATE_PREFIX = 'web.';

interface LoginState {
  verifier: string;
  next: string;
}

/** A same-origin path to go to after signing in, or '/'. Never another site. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || next.length > 512) return '/';
  return next;
}

export async function beginWebLogin(env: Env, next: string): Promise<{ state: string; verifier: string; cookie: string }> {
  const state = `${WEB_STATE_PREFIX}${randomToken(24)}`;
  const verifier = randomToken(48);
  await env.OAUTH_KV.put(`sop:login:${await sha256Hex(state)}`, JSON.stringify({ verifier, next: safeNext(next) } satisfies LoginState), { expirationTtl: LOGIN_SECONDS });
  return { state, verifier, cookie: cookie(LOGIN_COOKIE, state, LOGIN_SECONDS, { httpOnly: true, sameSite: 'Lax' }) };
}

/** Takes the login state back, once. The browser that started the login must be the one that finishes it. */
export async function finishWebLogin(env: Env, req: Request, state: string): Promise<{ verifier: string; next: string; clear: string } | null> {
  const bound = readCookie(req, LOGIN_COOKIE);
  const clear = cookie(LOGIN_COOKIE, '', 0, { httpOnly: true, sameSite: 'Lax' });
  if (!bound || !constantTimeEqual(bound, state)) return null;
  const key = `sop:login:${await sha256Hex(state)}`;
  const s = await env.OAUTH_KV.get<LoginState>(key, 'json');
  if (!s) return null;
  await env.OAUTH_KV.delete(key);
  return { verifier: s.verifier, next: safeNext(s.next), clear };
}
