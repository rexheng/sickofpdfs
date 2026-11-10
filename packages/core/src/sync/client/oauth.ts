// Signing in to the owner's own server (contracts CA11): OAuth 2.1 code flow with PKCE (S256), then refresh. The same for every
// first-party app; only the redirect and the way the sign-in page is opened differ:
//   - the extension: `chrome.identity.launchWebAuthFlow`, redirect `https://<extension id>.chromiumapp.org/oauth`;
//   - the Android app: the system browser (Custom Tabs), redirect `com.sickofpdfs.reader:/oauth`.
// This file builds the address, checks what comes back, and talks to the token endpoint. The caller opens the page and keeps
// the tokens (the extension: in `sop-local`, read only by the token broker).
//
// Nothing here logs or puts a token, code or verifier in an error message.

import { serverOrigin } from './http';

export const SYNC_SCOPE = 'sync offline_access';

/** The fixed, secret-less client ids the server registers for our own apps (`FIRST_PARTY_CLIENTS`). */
export const FIRST_PARTY_CLIENT_IDS = { extension: 'sickofpdfs-extension', android: 'sickofpdfs-android' } as const;

export interface PendingSignIn {
  /** Where to send the owner. */
  url: string;
  server: string;
  clientId: string;
  redirectUri: string;
  state: string;
  verifier: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** When the access token stops working (ms since 1970), a minute early. */
  accessExpiresAt: number;
  scope: string;
}

export class SignInError extends Error {
  constructor(
    /** `cancelled` (the owner closed the window), `refused` (the server said no: not the owner, or a revoked sign-in), `offline`, `bad-answer`. */
    readonly reason: 'cancelled' | 'refused' | 'offline' | 'bad-answer',
    message: string,
  ) {
    super(message);
    this.name = 'SignInError';
  }
}

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const random = (n: number): string => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** The address of the sign-in page, with a fresh PKCE verifier and state. */
export async function beginSignIn(o: { server: string; clientId: string; redirectUri: string }): Promise<PendingSignIn> {
  const server = serverOrigin(o.server);
  if (server === null) throw new SignInError('bad-answer', 'The server address must be https (or http on this computer).');
  const verifier = random(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = random(16);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: SYNC_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${server}/api`,
  });
  return { url: `${server}/authorize?${q.toString()}`, server, clientId: o.clientId, redirectUri: o.redirectUri, state, verifier };
}

/**
 * Reads the address the sign-in came back to: it must be our redirect, carry our state, and name our server as the issuer
 * (RFC 9207). Answers the code.
 */
export function readRedirect(p: PendingSignIn, returned: string): string {
  let u: URL;
  try {
    u = new URL(returned);
  } catch {
    throw new SignInError('bad-answer', 'The sign-in came back to an address that cannot be read.');
  }
  if (!`${u.origin}${u.pathname}`.startsWith(p.redirectUri.replace(/[?#].*$/, ''))) throw new SignInError('bad-answer', 'The sign-in came back to another address.');
  if (u.searchParams.get('state') !== p.state) throw new SignInError('bad-answer', 'The sign-in answer was not for this sign-in.');
  const iss = u.searchParams.get('iss');
  if (iss !== null && serverOrigin(iss) !== p.server) throw new SignInError('bad-answer', 'The sign-in answer came from another server.');
  const error = u.searchParams.get('error');
  if (error !== null) throw new SignInError(error === 'access_denied' ? 'refused' : 'bad-answer', error === 'access_denied' ? 'The server did not let this account in.' : 'The server refused the sign-in.');
  if (iss === null) throw new SignInError('bad-answer', 'The sign-in answer did not say which server it came from.');
  const code = u.searchParams.get('code');
  if (code === null || code === '') throw new SignInError('bad-answer', 'The sign-in answer had no code.');
  return code;
}

async function tokenCall(server: string, body: Record<string, string>, doFetch: typeof fetch, now: () => number): Promise<TokenSet> {
  let res: Response;
  try {
    res = await doFetch(`${server}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
  } catch {
    throw new SignInError('offline', 'The server could not be reached.');
  }
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown } | null;
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) throw new SignInError('offline', 'The server is busy. Try again soon.');
    throw new SignInError('refused', json?.error === 'invalid_grant' ? 'This sign-in has ended. Sign in again.' : 'The server refused the sign-in.');
  }
  if (typeof json?.access_token !== 'string' || typeof json.refresh_token !== 'string') throw new SignInError('bad-answer', 'The server sent no tokens.');
  const life = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in * 1000 : 3_600_000;
  return { accessToken: json.access_token, refreshToken: json.refresh_token, accessExpiresAt: now() + life - 60_000, scope: typeof json.scope === 'string' ? json.scope : SYNC_SCOPE };
}

/** Trades the code for tokens (with the PKCE verifier). */
export function finishSignIn(p: PendingSignIn, code: string, o: { fetch?: typeof fetch; now?: () => number } = {}): Promise<TokenSet> {
  return tokenCall(
    p.server,
    { grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, resource: `${p.server}/api` },
    o.fetch ?? ((...a) => fetch(...a)),
    o.now ?? Date.now,
  );
}

/** A new access token. Refresh tokens rotate: keep the one this answers with, and never use the old one again. */
export function refreshTokens(server: string, clientId: string, refreshToken: string, o: { fetch?: typeof fetch; now?: () => number } = {}): Promise<TokenSet> {
  const origin = serverOrigin(server);
  if (origin === null) return Promise.reject(new SignInError('bad-answer', 'The server address must be https (or http on this computer).'));
  return tokenCall(origin, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: `${origin}/api` }, o.fetch ?? ((...a) => fetch(...a)), o.now ?? Date.now);
}

/** Ends a sign-in on the server (RFC 7009, at the token endpoint). Best effort: signing out here never waits on it. */
export async function revokeToken(server: string, clientId: string, token: string, o: { fetch?: typeof fetch } = {}): Promise<boolean> {
  const origin = serverOrigin(server);
  if (origin === null) return false;
  try {
    const res = await (o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)))(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: clientId }).toString(),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    return res.ok;
  } catch {
    return false;
  }
}
