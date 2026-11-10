// The messages to the cloud token broker in the service worker (CL10, background/cloud-broker.ts), and small helpers that send
// them. Plain data both ways. No message ever carries the refresh token; only `cloud:token` carries an access token, and the
// broker answers it only to the offscreen document, where the sync engine runs.
//
// Nothing is sent anywhere until the owner connects their own server (R109): before that the broker answers every message
// from this computer alone, and makes no request.

export type CloudMessage =
  /** Settings → Cloud, "Connect": the owner's server address. Opens the sign-in window. Library page only. */
  | { type: 'cloud:signin'; server: string }
  /** Signs out (the server's sign-in ends too). `disconnect` also forgets the server address. Library page only. */
  | { type: 'cloud:signout'; disconnect?: boolean }
  /** A fresh access token for the sync engine. Offscreen document only. */
  | { type: 'cloud:token'; refresh?: boolean }
  | { type: 'cloud:status' }
  /** Settings → Cloud: the devices that sync (asked of the connected server, only while signed in). Library page only. */
  | { type: 'cloud:devices' }
  /** A reading was forgotten here: forget it in the cloud too (D2). Queued, and retried until it is done. */
  | { type: 'cloud:forget'; sha: string };

export interface CloudStatus {
  /** The owner connected a server (it may be signed out now). */
  connected: boolean;
  server: string | null;
  signedIn: boolean;
  /** Signed out on purpose (Sign out): sync is off, calmly. False when the server ended the sign-in ("Sync has stopped"). */
  signedOutByYou: boolean;
  /** Forgets still waiting to reach the cloud. */
  forgetsWaiting: number;
}

/** A device that syncs with the owner's cloud, as Settings → Cloud lists it. */
export interface CloudDeviceInfo {
  id: string;
  name: string;
  kind: string;
  createdAt: number;
  lastSeenAt: number | null;
  thisDevice: boolean;
}

export type CloudFailure = 'not-connected' | 'signed-out' | 'offline' | 'cancelled' | 'refused' | 'bad-answer' | 'not-allowed' | 'bad-request';

export type CloudReply<T> = ({ ok: true } & T) | { ok: false; reason: CloudFailure; message: string };

export interface CloudReplies {
  'cloud:signin': CloudReply<{ status: CloudStatus }>;
  'cloud:signout': CloudReply<{ status: CloudStatus }>;
  'cloud:token': CloudReply<{ token: string; server: string; expiresAt: number }>;
  'cloud:status': CloudReply<{ status: CloudStatus }>;
  'cloud:devices': CloudReply<{ devices: CloudDeviceInfo[] }>;
  'cloud:forget': CloudReply<{ queued: boolean }>;
}

export type CloudReplyOf<M extends CloudMessage> = CloudReplies[M['type']];

const TYPES: ReadonlySet<string> = new Set(['cloud:signin', 'cloud:signout', 'cloud:token', 'cloud:status', 'cloud:devices', 'cloud:forget']);

/** The message, if it is a well-formed cloud message; null otherwise. */
export function asCloudMessage(x: unknown): CloudMessage | null {
  if (typeof x !== 'object' || x === null) return null;
  const m = x as Record<string, unknown>;
  if (typeof m.type !== 'string' || !TYPES.has(m.type)) return null;
  switch (m.type) {
    case 'cloud:signin':
      return typeof m.server === 'string' && m.server.length <= 2048 ? { type: 'cloud:signin', server: m.server } : null;
    case 'cloud:signout':
      return { type: 'cloud:signout', disconnect: m.disconnect === true };
    case 'cloud:token':
      return { type: 'cloud:token', refresh: m.refresh === true };
    case 'cloud:status':
      return { type: 'cloud:status' };
    case 'cloud:devices':
      return { type: 'cloud:devices' };
    case 'cloud:forget':
      return typeof m.sha === 'string' && /^[0-9a-f]{64}$/.test(m.sha) ? { type: 'cloud:forget', sha: m.sha } : null;
    default:
      return null;
  }
}

async function send<M extends CloudMessage>(message: M): Promise<CloudReplyOf<M>> {
  try {
    const reply = await chrome.runtime.sendMessage<M, CloudReplyOf<M> | undefined>(message);
    return reply ?? ({ ok: false, reason: 'offline', message: 'The extension did not answer.' } as CloudReplyOf<M>);
  } catch {
    return { ok: false, reason: 'offline', message: 'The extension did not answer.' } as CloudReplyOf<M>;
  }
}

/**
 * Settings → Cloud, "Connect my own server". Call it straight from the click: it first asks Chrome for the sign-in permission
 * (`identity`, optional, so a fresh install asks for nothing), which needs the owner's click.
 */
export async function cloudSignIn(server: string): Promise<CloudReplyOf<{ type: 'cloud:signin'; server: string }>> {
  if ((import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE !== 'test') {
    let granted: boolean;
    try {
      granted = await chrome.permissions.request({ permissions: ['identity'] });
    } catch {
      granted = false;
    }
    if (!granted) return { ok: false, reason: 'not-allowed', message: 'Chrome needs your OK to open the sign-in window.' };
  }
  return send({ type: 'cloud:signin', server });
}

export const cloudSignOut = (disconnect = false) => send({ type: 'cloud:signout', disconnect });
export const cloudStatus = () => send({ type: 'cloud:status' });
/** Settings → Cloud: the devices that sync. Sends nothing when no server is connected or nobody is signed in. */
export const cloudDevices = () => send({ type: 'cloud:devices' });

/** For the offscreen sync engine: a fresh access token, or why there is none. */
export const cloudToken = (refresh = false) => send({ type: 'cloud:token', refresh });

/**
 * For viewer and library code, after a local Forget (CA8): the cloud forgets the reading too. Does nothing (and sends
 * nothing) when no server is connected. Never throws.
 */
export async function requestCloudForget(sha: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(sha)) return;
  await send({ type: 'cloud:forget', sha });
}
