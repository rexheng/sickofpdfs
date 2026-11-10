// The cloud token broker's store (CL10, contracts §7 and CA7): the owner's server address and the sign-in tokens, kept as the
// `cloud_token` secret in `sop-local`. This file and the broker that uses it (background/cloud-broker.ts) are the only code that
// reads the refresh token. It never imports secrets-store.ts and touches nothing else in `sop-local`: only `cloud_token`.
//
// The access token (1 hour) is handed to the offscreen sync engine by message; the refresh token never leaves this file except
// to the owner's own server's token endpoint. Refresh tokens rotate, so a refresh is single-flight: two callers at once share
// one refresh, and the new pair is stored before anyone gets the access token.
//
// Reads never create the database: until the owner connects a server, there is nothing to read, and nothing is sent anywhere.
// This file never logs, and no error it throws holds a token.
import { FIRST_PARTY_CLIENT_IDS, refreshTokens, revokeToken, SignInError, type TokenSet } from '@sop/core/sync-client';
import { connectLocalOnly, LOCAL_ONLY_DB, type LocalOnlyConnection } from './db';

const SECRET = 'cloud_token';
export const EXTENSION_CLIENT_ID = FIRST_PARTY_CLIENT_IDS.extension;

/** What is kept. `refreshToken` null: connected, but signed out. */
interface CloudRecord {
  v: 1;
  server: string;
  refreshToken: string | null;
  accessToken: string | null;
  accessExpiresAt: number;
  signedInAt: number | null;
  /** The app that signed in (contracts CA11): the extension, or the Android app, which shares this file. Refresh and sign-out use it. */
  clientId: string;
}

export interface CloudAuthState {
  connected: boolean;
  server: string | null;
  signedIn: boolean;
}

export type AccessToken = { ok: true; token: string; server: string; expiresAt: number } | { ok: false; reason: 'not-connected' | 'signed-out' | 'offline' };

let connection: Promise<LocalOnlyConnection> | null = null;
const conn = (): Promise<LocalOnlyConnection> => {
  connection ??= connectLocalOnly().catch((e: unknown) => {
    connection = null;
    throw e;
  });
  return connection;
};

/** Whether `sop-local` exists, without creating it. */
async function exists(): Promise<boolean> {
  try {
    return (await indexedDB.databases()).some((db) => db.name === LOCAL_ONLY_DB);
  } catch {
    return true; // cannot tell: open it (opening an existing one creates nothing)
  }
}

function parse(value: unknown): CloudRecord | null {
  if (typeof value !== 'string') return null;
  try {
    const r = JSON.parse(value) as Partial<CloudRecord>;
    if (r.v !== 1 || typeof r.server !== 'string') return null;
    return {
      v: 1,
      server: r.server,
      refreshToken: typeof r.refreshToken === 'string' ? r.refreshToken : null,
      accessToken: typeof r.accessToken === 'string' ? r.accessToken : null,
      accessExpiresAt: typeof r.accessExpiresAt === 'number' ? r.accessExpiresAt : 0,
      signedInAt: typeof r.signedInAt === 'number' ? r.signedInAt : null,
      clientId: typeof r.clientId === 'string' && r.clientId !== '' ? r.clientId : EXTENSION_CLIENT_ID,
    };
  } catch {
    return null;
  }
}

async function read(): Promise<CloudRecord | null> {
  if (!(await exists())) return null;
  const c = await conn();
  const raw = await c.transact<unknown>('secrets', 'readonly', (store, answer) => {
    const r = store.get(SECRET);
    r.onsuccess = () => answer((r.result as { value?: unknown } | undefined)?.value);
  });
  return parse(raw);
}

async function write(record: CloudRecord | null): Promise<void> {
  const c = await conn();
  await c.transact<void>('secrets', 'readwrite', (store) => {
    if (record === null) store.delete(SECRET);
    else store.put({ name: SECRET, value: JSON.stringify(record) });
  });
}

export async function cloudAuthState(): Promise<CloudAuthState> {
  const r = await read();
  return { connected: r !== null, server: r?.server ?? null, signedIn: r?.refreshToken != null };
}

/** The server the owner connected, or null. The network gate: no sync request goes anywhere else. */
export async function connectedServer(): Promise<string | null> {
  return (await read())?.server ?? null;
}

/** Keeps the tokens of a finished sign-in to `server` (an origin) by `clientId`. Replaces any earlier sign-in. */
export async function saveSignIn(server: string, tokens: TokenSet, now = Date.now(), clientId: string = EXTENSION_CLIENT_ID): Promise<void> {
  refreshing = null;
  await write({ v: 1, server, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, accessExpiresAt: tokens.accessExpiresAt, signedInAt: now, clientId });
}

/**
 * Signs out: the tokens go at once, and the server is asked to end the sign-in (best effort; a sign-in also ends by itself 90
 * days after its last use). `disconnect` also forgets the server, so nothing is ever sent to it again.
 */
export async function signOut(o: { disconnect?: boolean; fetch?: typeof fetch } = {}): Promise<void> {
  const r = await read();
  if (r === null) return;
  refreshing = null;
  await write(o.disconnect === true ? null : { ...r, refreshToken: null, accessToken: null, accessExpiresAt: 0, signedInAt: null });
  if (r.refreshToken !== null) await revokeToken(r.server, r.clientId, r.refreshToken, { fetch: o.fetch });
}

let refreshing: Promise<AccessToken> | null = null;

/** A fresh access token for the connected server, refreshing it (once, for every caller at that moment) when it is stale. */
export async function accessToken(o: { forceRefresh?: boolean; now?: () => number; fetch?: typeof fetch } = {}): Promise<AccessToken> {
  const now = o.now ?? Date.now;
  const r = await read();
  if (r === null) return { ok: false, reason: 'not-connected' };
  if (r.refreshToken === null) return { ok: false, reason: 'signed-out' };
  if (o.forceRefresh !== true && r.accessToken !== null && r.accessExpiresAt > now()) return { ok: true, token: r.accessToken, server: r.server, expiresAt: r.accessExpiresAt };
  refreshing ??= (async (): Promise<AccessToken> => {
    try {
      // Read again inside the flight: another flight may have rotated the refresh token a moment ago.
      const cur = await read();
      if (cur === null) return { ok: false, reason: 'not-connected' };
      if (cur.refreshToken === null) return { ok: false, reason: 'signed-out' };
      if (o.forceRefresh !== true && cur.accessToken !== null && cur.accessExpiresAt > now()) return { ok: true, token: cur.accessToken, server: cur.server, expiresAt: cur.accessExpiresAt };
      let t: TokenSet;
      try {
        t = await refreshTokens(cur.server, cur.clientId, cur.refreshToken, { fetch: o.fetch, now });
      } catch (e) {
        if (e instanceof SignInError && e.reason === 'refused') {
          // The sign-in ended (revoked, expired, or no longer the owner): signed out, server kept.
          await write({ ...cur, refreshToken: null, accessToken: null, accessExpiresAt: 0, signedInAt: null });
          return { ok: false, reason: 'signed-out' };
        }
        return { ok: false, reason: 'offline' };
      }
      await write({ ...cur, refreshToken: t.refreshToken, accessToken: t.accessToken, accessExpiresAt: t.accessExpiresAt });
      return { ok: true, token: t.accessToken, server: cur.server, expiresAt: t.accessExpiresAt };
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
