// GitHub sign-in: the identity step behind both doors (the OAuth flow for apps and the web library's cookie session). We ask
// GitHub for no scopes: only the account's numeric id is needed, and its token is used once, for `GET /user`, then dropped.
// It is never stored and never logged.

import type { Env } from '../env';

export interface GithubUser {
  id: string;
  login: string;
}

/** Where GitHub lives. The overrides work only in `local` (the fake GitHub), so a stray variable can never redirect a real sign-in. */
export function githubUrls(env: Env): { web: string; api: string } {
  if (env.ENVIRONMENT === 'local') return { web: env.GITHUB_BASE_URL ?? 'https://github.com', api: env.GITHUB_API_URL ?? 'https://api.github.com' };
  return { web: 'https://github.com', api: 'https://api.github.com' };
}

export const githubCallbackUrl = (env: Env): string => `${env.PUBLIC_URL}/oauth/github/callback`;

export function githubAuthorizeUrl(env: Env, state: string, codeChallenge: string): string {
  const u = new URL('/login/oauth/authorize', githubUrls(env).web);
  u.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: githubCallbackUrl(env),
    scope: '',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    allow_signup: 'false',
  }).toString();
  return u.toString();
}

export class GithubError extends Error {
  constructor(readonly step: 'token' | 'user', message: string) {
    super(message);
    this.name = 'GithubError';
  }
}

/** Swaps GitHub's code for the signed-in account. Throws `GithubError` with no secret in the message. */
export async function githubUserFromCode(env: Env, code: string, codeVerifier: string): Promise<GithubUser> {
  const { web, api } = githubUrls(env);
  const tokenRes = await fetch(new URL('/login/oauth/access_token', web), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'sickofpdfs' },
    body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: githubCallbackUrl(env), code_verifier: codeVerifier }),
  });
  if (!tokenRes.ok) throw new GithubError('token', `GitHub answered ${tokenRes.status}`);
  const t: { access_token?: unknown; error?: unknown } = (await tokenRes.json<unknown>().catch(() => null)) ?? {};
  if (typeof t.access_token !== 'string' || t.access_token === '') throw new GithubError('token', `GitHub refused the code (${typeof t.error === 'string' ? t.error.slice(0, 60) : 'no token'})`);

  const userRes = await fetch(new URL('/user', api), {
    headers: { authorization: `Bearer ${t.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'sickofpdfs', 'x-github-api-version': '2022-11-28' },
  });
  if (!userRes.ok) throw new GithubError('user', `GitHub answered ${userRes.status} for the account`);
  const u: { id?: unknown; login?: unknown } = (await userRes.json<unknown>().catch(() => null)) ?? {};
  if (typeof u.id !== 'number' || !Number.isSafeInteger(u.id) || u.id <= 0) throw new GithubError('user', 'GitHub sent no account id');
  return { id: String(u.id), login: typeof u.login === 'string' ? u.login.slice(0, 100) : '' };
}

/** The one rule: only the owner's numeric GitHub id gets in. A missing setting lets nobody in. */
export function isOwner(env: Env, uid: string | undefined | null): boolean {
  const owner = (env.ALLOWED_GITHUB_ID ?? '').trim();
  return /^\d+$/.test(owner) && uid === owner;
}

// ─── Small crypto helpers shared by the auth area ─────────────────────────────────────────────────────────────────────────

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export const randomToken = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares two strings in time that does not depend on where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  // Compare against itself when the lengths differ, so the time does not depend on the secret's length either
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?(x: ArrayBufferView, y: ArrayBufferView): boolean };
  if (ea.length !== eb.length) {
    subtle.timingSafeEqual?.(ea, ea);
    return false;
  }
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(ea, eb);
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
