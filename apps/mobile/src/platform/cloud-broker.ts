// The app's door to the owner's cloud (R109, R110; contracts CA11): the phone's version of the extension's token broker
// (apps/extension/src/background/cloud-broker.ts). It signs in through a Custom Tab, keeps the tokens in the app's private store
// (`sop-local`, through the extension's own local-only/cloud-auth.ts, which only this file and the extension's broker read), hands
// the sync engine fresh access tokens, and sends the queued Forgets.
//
// The app is one page at a time with no service worker, so the broker runs in the page itself. It answers the extension's cloud
// messages in the page (chrome-shim.ts `onAppMessage`), so the extension's library code that asks the cloud something works
// unchanged.
//
// Network (R109, R110): nothing at all is sent until the owner taps Connect in Settings → Cloud. After that, only the address they
// connected is ever called. The pages' Content-Security-Policy allows that one host and no other (cloud-config.ts).
// This file never logs, and no error it gives holds a token, a code or a verifier.
import { beginSignIn, createSyncClient, type EngineConnection, finishSignIn, FIRST_PARTY_CLIENT_IDS, readRedirect, serverOrigin, SignInError, SyncHttpError } from '@sop/core/sync-client';
import { accessToken, cloudAuthState, connectedServer, saveSignIn, signOut } from '@ext/local-only/cloud-auth';
import { drainForgets, enqueueForget, queuedForgets } from '@ext/local-only/cloud-forget';
import { asCloudMessage, type CloudFailure, type CloudReplies, type CloudStatus } from '@ext/shared/cloud-messages';
import { ANDROID_REDIRECT, SYNC_ORIGINS } from './cloud-config';
import { isNativeApp, SopPlatform } from './native';

export const ANDROID_CLIENT_ID = FIRST_PARTY_CLIENT_IDS.android;

/** Fired after Connect, Sign out and Disconnect, so the sync host and Settings → Cloud look again. */
export const cloudEvents = new EventTarget();
const changed = () => cloudEvents.dispatchEvent(new Event('changed'));

function fail(reason: CloudFailure, message: string): { ok: false; reason: CloudFailure; message: string } {
  return { ok: false, reason, message };
}

export async function cloudStatusHere(): Promise<CloudStatus> {
  const s = await cloudAuthState();
  return { ...s, forgetsWaiting: s.connected ? (await queuedForgets()).length : 0 };
}

/** Whether this build may talk to `server` (an origin): its pages' rules allow only these hosts. */
export const serverAllowed = (server: string): boolean => SYNC_ORIGINS.some((o) => serverOrigin(o) === server);

// ─── Opening the sign-in page ─────────────────────────────────────────────────────────────────────────────────────────

/** How long a sign-in may take before it is given up (the owner may need to sign in to GitHub first). */
const SIGN_IN_MAX_MS = 10 * 60_000;
/** After the app comes back to the front with no answer, the owner closed the browser: wait this long for a late answer. */
const CLOSED_GRACE_MS = 1_500;

/** The Custom Tab: resolves with the address the sign-in came back to, `com.sickofpdfs.reader:/oauth?…`. */
function signInInCustomTab(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let finished = false;
    const handles: Promise<{ remove(): Promise<void> }>[] = [];
    let grace: ReturnType<typeof setTimeout> | null = null;
    const done = (f: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(limit);
      if (grace !== null) clearTimeout(grace);
      for (const h of handles) void h.then((x) => x.remove()).catch(() => {});
      f();
    };
    const limit = setTimeout(() => done(() => reject(new SignInError('cancelled', 'The sign-in took too long. Try again.'))), SIGN_IN_MAX_MS);
    handles.push(SopPlatform.addListener('oauth', (e) => done(() => resolve(e.url))));
    handles.push(
      SopPlatform.addListener('resume', () => {
        if (grace !== null) clearTimeout(grace);
        grace = setTimeout(() => done(() => reject(new SignInError('cancelled', 'The sign-in page was closed.'))), CLOSED_GRACE_MS);
      }),
    );
    SopPlatform.openSignIn({ url }).catch(() => done(() => reject(new SignInError('cancelled', 'The phone could not open the sign-in page.'))));
  });
}

/**
 * The test build only (`vite build --mode test`, in a desktop browser): the sign-in opens in a new window, and the test hands back
 * the address it came back to with `postMessage({ type: 'sop-test-oauth', url })`. A real build never listens for this.
 */
function signInInTestWindow(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; url?: unknown } | null;
      if (e.origin !== location.origin || d?.type !== 'sop-test-oauth' || typeof d.url !== 'string') return;
      removeEventListener('message', onMessage);
      resolve(d.url);
    };
    addEventListener('message', onMessage);
    if (window.open(url, '_blank') === null) {
      removeEventListener('message', onMessage);
      reject(new SignInError('cancelled', 'The sign-in window did not open.'));
    }
  });
}

function openSignInPage(url: string): Promise<string> {
  if (isNativeApp()) return signInInCustomTab(url);
  if (import.meta.env.MODE === 'test') return signInInTestWindow(url);
  return Promise.reject(new SignInError('cancelled', 'Signing in works in the Android app.'));
}

// ─── Forget ───────────────────────────────────────────────────────────────────────────────────────────────────────────

let draining: Promise<number> | null = null;

/** Sends every queued Forget to the connected server. Does nothing when no server is connected or nobody is signed in. */
export function drainForgetsHere(): Promise<number> {
  draining ??= (async () => {
    try {
      const server = await connectedServer();
      if (server === null) return 0;
      if ((await queuedForgets()).length === 0) return 0;
      const first = await accessToken();
      if (!first.ok) return (await queuedForgets()).length;
      const client = createSyncClient({
        server,
        token: async () => {
          const t = await accessToken();
          return t.ok ? t.token : null;
        },
      });
      return await drainForgets(async (sha, at) => {
        try {
          await client.forget(sha, at);
          return 'done';
        } catch (e) {
          if (e instanceof SyncHttpError && e.failure === 'refused') return e.status === 404 ? 'done' : 'retry';
          return 'stop';
        }
      });
    } catch {
      return 0;
    } finally {
      draining = null;
    }
  })();
  return draining;
}

// ─── Sign-in, sign-out, tokens ────────────────────────────────────────────────────────────────────────────────────────

let signingIn: Promise<CloudReplies['cloud:signin']> | null = null;

/** Settings → Cloud, "Connect": signs in to the owner's server (an address they typed or kept). */
export function signInHere(input: string): Promise<CloudReplies['cloud:signin']> {
  const server = serverOrigin(input);
  if (server === null) return Promise.resolve(fail('bad-request', 'The address must start with https://.'));
  if (!serverAllowed(server)) {
    const hosts = SYNC_ORIGINS.map((o) => new URL(o).host).join(' or ');
    return Promise.resolve(fail('bad-request', `This app can connect only to ${hosts}.`));
  }
  signingIn ??= (async (): Promise<CloudReplies['cloud:signin']> => {
    try {
      const pending = await beginSignIn({ server, clientId: ANDROID_CLIENT_ID, redirectUri: ANDROID_REDIRECT });
      const back = await openSignInPage(pending.url);
      const tokens = await finishSignIn(pending, readRedirect(pending, back));
      await saveSignIn(server, tokens, Date.now(), ANDROID_CLIENT_ID);
      changed();
      void drainForgetsHere();
      return { ok: true, status: await cloudStatusHere() };
    } catch (e) {
      if (e instanceof SignInError) return fail(e.reason, e.message);
      return fail('offline', 'The sign-in did not finish. Try again.');
    } finally {
      signingIn = null;
    }
  })();
  return signingIn;
}

/** Signs out (the server's sign-in ends too). `disconnect` also forgets the server, so nothing is ever sent to it again. */
export async function signOutHere(disconnect: boolean): Promise<{ ok: true; status: CloudStatus }> {
  await signOut({ disconnect });
  changed();
  return { ok: true, status: await cloudStatusHere() };
}

/** The sync engine's connection: null until the owner connects a server, and then only that server. */
export async function connectionHere(): Promise<EngineConnection | null> {
  let server: string | null;
  try {
    server = await connectedServer();
  } catch {
    return null;
  }
  if (server === null || !serverAllowed(server)) return null;
  // Signed out on purpose: sync is simply off, with no "Sync has stopped" (Settings → Cloud says "Signed out")
  const auth = await cloudAuthState().catch(() => null);
  if (auth !== null && !auth.signedIn && auth.signedOutByYou) return null;
  return {
    server,
    token: async (refresh = false) => {
      const t = await accessToken({ forceRefresh: refresh });
      if (!t.ok || t.server !== server) return null;
      // Queued Forgets go first, so a sync round never sends a reading's old rows before the cloud has forgotten them
      if ((await queuedForgets().catch(() => [])).length > 0) await drainForgetsHere();
      return t.token;
    },
  };
}

/** After a local Forget (CA8): the cloud forgets the reading too. Nothing is queued or sent when no server is connected. */
export async function forgetHere(sha: string): Promise<CloudReplies['cloud:forget']> {
  if ((await connectedServer()) === null) return { ok: true, queued: false };
  await enqueueForget(sha);
  void drainForgetsHere();
  return { ok: true, queued: true };
}

/** Answers the extension's cloud messages in this page (chrome-shim.ts). The sync engine runs here, so no page asks for a token. */
export function cloudMessageAnswer(raw: unknown): Promise<unknown> | undefined {
  const m = asCloudMessage(raw);
  if (m === null) return undefined;
  const answer = async (): Promise<unknown> => {
    switch (m.type) {
      case 'cloud:status':
        return { ok: true, status: await cloudStatusHere() };
      case 'cloud:signin':
        return signInHere(m.server);
      case 'cloud:signout':
        return signOutHere(m.disconnect === true);
      case 'cloud:forget':
        return forgetHere(m.sha);
      case 'cloud:token':
        return fail('not-allowed', 'Only the sync engine gets a token.');
    }
  };
  return answer().catch(() => fail('offline', 'Something went wrong. Try again.'));
}
