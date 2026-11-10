// The OAuth authorization server (CL3): one issuer, the Worker's own address, and two protected resources, the sync API
// (`<PUBLIC_URL>/api`) and the claude.ai connector (`<PUBLIC_URL>/mcp`). A token is bound to exactly one of them, so a sync
// token fails on /mcp and a connector token fails on /api (the library checks the audience).
//
// Built on @cloudflare/workers-oauth-provider: it owns the token endpoint, refresh rotation, revocation, registration, the
// metadata document, CIMD, PKCE and `iss` (RFC 9207), and keeps tokens, codes and secrets in KV as hashes only. This file
// decides the policy: which clients exist, which scopes each resource may get, and that only the owner ever holds a token.

import { OAuthAuthorizationServer, OAuthError, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Env } from '../env';

export type ResourceKind = 'api' | 'mcp';

/** Every scope this server can grant (RFC 8414 `scopes_supported`). */
export const SCOPES_SUPPORTED = ['library:read', 'library:comment', 'sync', 'offline_access'] as const;
export type Scope = (typeof SCOPES_SUPPORTED)[number];

/** What a resource may be granted. The sync API never gets `library:comment`; the connector never gets `sync`. */
export const RESOURCE_SCOPES: Record<ResourceKind, readonly Scope[]> = {
  api: ['sync', 'library:read', 'offline_access'],
  mcp: ['library:read', 'library:comment', 'offline_access'],
};

/** The scopes an unauthenticated request is told to ask for (the 401 challenge and the resource metadata). */
export const CHALLENGE_SCOPES: Record<ResourceKind, readonly Scope[]> = {
  api: ['sync'],
  // Both, so claude.ai asks for comments up front; the consent page also offers "reading only".
  mcp: ['library:read', 'library:comment'],
};

/**
 * Our own apps, registered once with fixed ids (they are public clients: PKCE, no secret). Only these may get a token for the
 * sync API: a connector such as claude.ai can never sync, download a PDF or push as a device.
 */
export const FIRST_PARTY_CLIENTS = {
  extension: 'sickofpdfs-extension',
  android: 'sickofpdfs-android',
} as const;
export type FirstPartyKind = keyof typeof FIRST_PARTY_CLIENTS;

/** The Android app's private-use redirect (RFC 8252 §7.1): its package id, reversed-DNS form. */
export const ANDROID_SCHEME_REDIRECT = 'com.sickofpdfs.reader:/oauth';

export function firstPartyKind(clientId: string): FirstPartyKind | null {
  for (const [kind, id] of Object.entries(FIRST_PARTY_CLIENTS)) if (id === clientId) return kind as FirstPartyKind;
  return null;
}

export const resourceUrl = (env: Pick<Env, 'PUBLIC_URL'>, kind: ResourceKind): string => `${env.PUBLIC_URL}/${kind}`;
export const resourceMetadataUrl = (env: Pick<Env, 'PUBLIC_URL'>, kind: ResourceKind): string => `${env.PUBLIC_URL}/.well-known/oauth-protected-resource/${kind}`;

export function resourceKindOf(env: Pick<Env, 'PUBLIC_URL'>, resource: string | undefined): ResourceKind | null {
  if (resource === resourceUrl(env, 'api')) return 'api';
  if (resource === resourceUrl(env, 'mcp')) return 'mcp';
  return null;
}

/** Redirect addresses each first-party client signs in through. */
export function firstPartyRedirects(env: Env, kind: FirstPartyKind): string[] {
  if (kind === 'extension') return [`https://${env.EXTENSION_ID}.chromiumapp.org/oauth`];
  // The app link (an https address the app claims, verified by /.well-known/assetlinks.json) and the private-use scheme
  return [`${env.PUBLIC_URL}/app/oauth`, ANDROID_SCHEME_REDIRECT];
}

const FIRST_PARTY_NAMES: Record<FirstPartyKind, string> = { extension: 'sickofpdfs for Chrome', android: 'sickofpdfs for Android' };

const DAY = 24 * 60 * 60;

/** Whether this runtime has `global_fetch_strictly_public`, which the library requires before it fetches a client's metadata. */
function hasStrictlyPublicFetch(): boolean {
  const flags = (globalThis as { Cloudflare?: { compatibilityFlags?: Record<string, boolean> } }).Cloudflare?.compatibilityFlags;
  return flags?.global_fetch_strictly_public === true;
}

/**
 * The restricted dynamic registration fallback: a client may register only redirect addresses we already know: claude.ai's and
 * claude.com's connector callbacks, a loopback address (Claude Code and other local tools), or the extension's own address.
 */
export function dcrRedirectAllowed(env: Env, uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === 'https:' && (u.host === 'claude.ai' || u.host === 'claude.com') && u.pathname === '/api/mcp/auth_callback') return true;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return true;
  if (u.protocol === 'https:' && u.host === `${env.EXTENSION_ID}.chromiumapp.org`) return true;
  return false;
}

const servers = new Map<string, OAuthAuthorizationServer<Env>>();

/** The authorization server for this Worker's address (one per isolate and address). */
export function authorizationServer(env: Env): OAuthAuthorizationServer<Env> {
  const key = `${env.PUBLIC_URL}|${env.EXTENSION_ID}`;
  let as = servers.get(key);
  if (as) return as;
  as = new OAuthAuthorizationServer<Env>({
    issuer: env.PUBLIC_URL,
    resources: [resourceUrl(env, 'api'), resourceUrl(env, 'mcp')],
    // Conforming MCP clients always send `resource`; an older one that does not is a connector, never a sync client.
    defaultResource: resourceUrl(env, 'mcp'),
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: [...SCOPES_SUPPORTED],
    // Contracts §7: 1-hour access tokens. A sign-in lives 90 days from its last use, so a computer that syncs stays signed in.
    accessTokenTTL: 3600,
    refreshTokenTTL: 90 * DAY,
    refreshTokenIdleTTL: 90 * DAY,
    clientRegistrationTTL: 90 * DAY,
    // CIMD ("Use Claude's published identity"). The library needs `global_fetch_strictly_public` (SSRF protection), which the
    // staging and production Workers have; `wrangler dev` does not, so there CIMD is off and only registered clients sign in.
    clientIdMetadataDocumentEnabled: hasStrictlyPublicFetch(),
    // The Android app's private-use redirect. /authorize allows it for that one client only (policy.ts).
    allowPrivateUseRedirectUris: true,
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = clientMetadata.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string' && dcrRedirectAllowed(env, u))) {
        return { code: 'invalid_redirect_uri', description: 'This server accepts only the claude.ai, claude.com and local callback addresses.' };
      }
      return undefined;
    },
    // The owner check again on every refresh: a token for anyone else never renews (and the grant is revoked).
    tokenExchangeCallback: ({ props, env: e }) => {
      const p = props as Partial<GrantProps> | undefined;
      if (!p || p.uid !== e.ALLOWED_GITHUB_ID) throw new OAuthError('invalid_grant', { description: 'This sign-in is not the owner\'s.' });
      return undefined;
    },
    // Never log a token or a code: only the error code and the library's internal reason.
    onError: ({ code, internal }) => {
      console.warn(JSON.stringify({ event: 'oauth_error', code, reason: (internal as { reason?: string } | undefined)?.reason ?? null }));
      return undefined;
    },
  });
  servers.set(key, as);
  return as;
}

export const oauthApi = (env: Env): OAuthHelpers => authorizationServer(env).getOAuthApi(env);

/** What every grant's (encrypted) props hold. */
export interface GrantProps {
  /** The owner's numeric GitHub id, as text. */
  uid: string;
  login: string;
  resource: ResourceKind;
}

/** What every grant's (plain, listable) metadata holds. Nothing secret. */
export interface GrantMetadata {
  clientName: string;
  resource: ResourceKind;
  firstParty: FirstPartyKind | null;
}

/**
 * Registers our own apps as public clients with fixed ids: the extension (contracts §7: "a client registered once, not DCR")
 * and the Android app. Idempotent: a record that is missing or out of date
 * (a new extension id, a new address) is written again. /authorize and the token endpoint call it (one KV read each), so a
 * fresh KV heals itself; the bootstrap smoke test reaches it through /authorize.
 *
 * The library makes random ids, so the record is put under the fixed id first and then rewritten through `updateClient`,
 * which holds it to the same redirect and grant rules as any registration.
 */
export async function registerFirstPartyClients(env: Env): Promise<void> {
  const oauth = oauthApi(env);
  for (const kind of Object.keys(FIRST_PARTY_CLIENTS) as FirstPartyKind[]) {
    const clientId = FIRST_PARTY_CLIENTS[kind];
    const redirectUris = firstPartyRedirects(env, kind);
    const existing = await oauth.lookupClient(clientId);
    const same =
      existing !== null &&
      existing.tokenEndpointAuthMethod === 'none' &&
      existing.clientName === FIRST_PARTY_NAMES[kind] &&
      existing.redirectUris.length === redirectUris.length &&
      existing.redirectUris.every((u, i) => u === redirectUris[i]);
    if (same) continue;
    if (existing === null) {
      await env.OAUTH_KV.put(
        `client:${clientId}`,
        JSON.stringify({ clientId, redirectUris, tokenEndpointAuthMethod: 'none', authMethodExplicit: true, grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], registrationDate: Math.floor(Date.now() / 1000) }),
      );
    }
    try {
      await oauth.updateClient(clientId, { redirectUris, clientName: FIRST_PARTY_NAMES[kind], tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'] });
    } catch (e) {
      if (existing === null) await env.OAUTH_KV.delete(`client:${clientId}`);
      throw e;
    }
  }
}

/** The plan's name for the same step (CL3): bootstrap and the harness call it. */
export const registerExtensionClient = registerFirstPartyClients;
