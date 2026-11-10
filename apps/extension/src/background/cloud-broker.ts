// The cloud token broker (CL10, contracts §7 and CA7). It runs in the service worker and is the one door to the owner's cloud
// sign-in: it opens the sign-in window, keeps the tokens (local-only/cloud-auth.ts), hands 1-hour access tokens to the offscreen
// sync engine, and sends the queued Forgets (local-only/cloud-forget.ts).
//
// Who may ask what:
//   cloud:signin, cloud:signout   the library page (Settings → Cloud) only
//   cloud:token                   the offscreen document only (the sync engine); no page, tab or content script ever gets a token
//   cloud:status, cloud:forget    any of this extension's own pages
// A content script runs in a web page's origin and is refused everything here. So is any other extension.
//
// Network (R109, R110): nothing at all is sent until the owner connects a server. After that, only the address they connected is
// ever called, and only for sign-in, refresh, sign-out and Forget (sync itself runs in the offscreen document, with the token).
import { beginSignIn, createSyncClient, finishSignIn, readRedirect, serverOrigin, SignInError, SyncHttpError } from '@sop/core/sync-client';
import { accessToken, cloudAuthState, connectedServer, EXTENSION_CLIENT_ID, saveSignIn, signOut } from '../local-only/cloud-auth';
import { drainForgets, enqueueForget, queuedForgets } from '../local-only/cloud-forget';
import { asCloudMessage, type CloudFailure, type CloudMessage, type CloudReplies, type CloudStatus } from '../shared/cloud-messages';
import { OFFSCREEN_PATH } from '../store/transport';

const FORGET_ALARM = 'sop-cloud-forget';
const FORGET_EVERY_MIN = 15;

type Sender = chrome.runtime.MessageSender;

const extensionUrl = (path = ''): string => chrome.runtime.getURL(path);
const pathOf = (url: string): string => url.split(/[?#]/)[0] ?? '';
const fromOwnPage = (s: Sender): boolean => s.id === chrome.runtime.id && typeof s.url === 'string' && s.url.startsWith(extensionUrl(''));
const fromLibrary = (s: Sender): boolean => fromOwnPage(s) && pathOf(s.url ?? '') === extensionUrl('library.html');
const fromOffscreen = (s: Sender): boolean => fromOwnPage(s) && pathOf(s.url ?? '') === extensionUrl(OFFSCREEN_PATH.replace(/^\//, ''));

/** The address the sign-in comes back to: `https://<extension id>.chromiumapp.org/oauth` (contracts CA11). */
const redirectUri = (): string => `https://${chrome.runtime.id}.chromiumapp.org/oauth`;

function fail(reason: CloudFailure, message: string): { ok: false; reason: CloudFailure; message: string } {
  return { ok: false, reason, message };
}

async function status(): Promise<CloudStatus> {
  const s = await cloudAuthState();
  return { ...s, forgetsWaiting: s.connected ? (await queuedForgets()).length : 0 };
}

// ─── Opening the sign-in page ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Opens the server's sign-in page and answers the address it came back to. Chrome's sign-in window in a real build. A test build
 * (`wxt build --mode test`) has no `identity` permission and Playwright cannot click in that window, so it opens a normal tab
 * instead and watches for the redirect (the plan's "headless follower"); the redirect itself is blocked, so it never leaves the
 * computer.
 */
async function openSignInPage(url: string): Promise<string> {
  if (import.meta.env.MODE === 'test') return followInTab(url);
  if (!chrome.identity?.launchWebAuthFlow) throw new SignInError('cancelled', 'Chrome needs your OK to open the sign-in window.');
  let back: string | undefined;
  try {
    back = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch {
    throw new SignInError('cancelled', 'The sign-in window was closed.');
  }
  if (typeof back !== 'string') throw new SignInError('cancelled', 'The sign-in window was closed.');
  return back;
}

const TEST_BLOCK_RULE = 4_242_001;

function followInTab(url: string): Promise<string> {
  const target = redirectUri();
  return new Promise<string>((resolve, reject) => {
    let tabId: number | undefined;
    let finished = false;
    const done = (f: () => void) => {
      if (finished) return;
      finished = true;
      chrome.webRequest.onBeforeRedirect.removeListener(onRedirect);
      chrome.webNavigation.onBeforeNavigate.removeListener(onNav);
      chrome.tabs.onRemoved.removeListener(onClosed);
      void chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [TEST_BLOCK_RULE] }).catch(() => {});
      f();
    };
    const caught = (tab: number, to: string) => {
      if (tab !== tabId || !to.startsWith(target)) return;
      done(() => resolve(to));
      void chrome.tabs.remove(tab).catch(() => {});
    };
    // The server answers the sign-in with a redirect to the extension's address: seen here, before it is followed.
    const onRedirect = (d: { tabId: number; redirectUrl: string }) => caught(d.tabId, d.redirectUrl);
    const onNav = (d: { tabId: number; url: string }) => caught(d.tabId, d.url);
    const onClosed = (id: number) => {
      if (id === tabId) done(() => reject(new SignInError('cancelled', 'The sign-in tab was closed.')));
    };
    chrome.webRequest.onBeforeRedirect.addListener(onRedirect, { urls: ['<all_urls>'], types: ['main_frame'] });
    chrome.webNavigation.onBeforeNavigate.addListener(onNav);
    chrome.tabs.onRemoved.addListener(onClosed);
    const host = new URL(target).host;
    void chrome.declarativeNetRequest
      .updateSessionRules({
        removeRuleIds: [TEST_BLOCK_RULE],
        addRules: [{ id: TEST_BLOCK_RULE, priority: 100, action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK }, condition: { requestDomains: [host], resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME] } }],
      })
      .then(() => chrome.tabs.create({ url, active: true }))
      .then((tab) => {
        tabId = tab.id;
      })
      .catch((e: unknown) => done(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });
}

// ─── Forget ───────────────────────────────────────────────────────────────────────────────────────────────────────────

let draining: Promise<number> | null = null;

/** Sends every queued Forget to the connected server. Does nothing when no server is connected or nobody is signed in. */
function drain(): Promise<number> {
  draining ??= (async () => {
    try {
      const server = await connectedServer();
      if (server === null) return 0;
      const first = await accessToken();
      if (!first.ok) return (await queuedForgets()).length;
      const client = createSyncClient({ server, token: async () => { const t = await accessToken(); return t.ok ? t.token : null; } });
      return await drainForgets(async (sha) => {
        try {
          await client.forget(sha);
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

// ─── Messages ─────────────────────────────────────────────────────────────────────────────────────────────────────────

let signingIn: Promise<CloudReplies['cloud:signin']> | null = null;

async function handle(m: CloudMessage, sender: Sender): Promise<CloudReplies[CloudMessage['type']]> {
  switch (m.type) {
    case 'cloud:status':
      if (!fromOwnPage(sender)) return fail('not-allowed', 'Not from this extension.');
      return { ok: true, status: await status() };

    case 'cloud:token': {
      if (!fromOffscreen(sender)) return fail('not-allowed', 'Only the sync engine gets a token.');
      const t = await accessToken({ forceRefresh: m.refresh === true });
      if (!t.ok) return fail(t.reason, t.reason === 'offline' ? 'The server could not be reached.' : t.reason === 'signed-out' ? 'Signed out of the cloud.' : 'No cloud is connected.');
      void drain();
      return { ok: true, token: t.token, server: t.server, expiresAt: t.expiresAt };
    }

    case 'cloud:signin': {
      if (!fromLibrary(sender)) return fail('not-allowed', 'Sign in from Settings.');
      const server = serverOrigin(m.server);
      if (server === null) return fail('bad-request', 'The address must start with https://.');
      signingIn ??= (async (): Promise<CloudReplies['cloud:signin']> => {
        try {
          const pending = await beginSignIn({ server, clientId: EXTENSION_CLIENT_ID, redirectUri: redirectUri() });
          const back = await openSignInPage(pending.url);
          const tokens = await finishSignIn(pending, readRedirect(pending, back));
          await saveSignIn(server, tokens);
          void drain();
          return { ok: true, status: await status() };
        } catch (e) {
          if (e instanceof SignInError) return fail(e.reason, e.message);
          return fail('offline', 'The sign-in did not finish. Try again.');
        } finally {
          signingIn = null;
        }
      })();
      return signingIn;
    }

    case 'cloud:signout':
      if (!fromLibrary(sender)) return fail('not-allowed', 'Sign out from Settings.');
      await signOut({ disconnect: m.disconnect === true });
      return { ok: true, status: await status() };

    case 'cloud:forget': {
      if (!fromOwnPage(sender)) return fail('not-allowed', 'Not from this extension.');
      // With no server connected there is no cloud copy: nothing to queue, nothing to send.
      if ((await connectedServer()) === null) return { ok: true, queued: false };
      await enqueueForget(m.sha);
      void drain();
      return { ok: true, queued: true };
    }
  }
}

/** Registers the broker's listeners. Call it synchronously when the service worker starts. */
export function installCloudBroker(): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const m = asCloudMessage(message);
    if (m === null) return undefined; // not ours: another listener answers
    handle(m, sender).then(sendResponse, () => sendResponse(fail('offline', 'Something went wrong. Try again.')));
    return true;
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FORGET_ALARM) void drain();
  });
  // The alarm only matters once a server is connected; it costs nothing and sends nothing before that.
  void chrome.alarms.get(FORGET_ALARM).then((a) => {
    if (a === undefined) void chrome.alarms.create(FORGET_ALARM, { periodInMinutes: FORGET_EVERY_MIN });
  });
}
