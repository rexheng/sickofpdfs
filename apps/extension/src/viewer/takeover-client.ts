// The viewer's calls to the takeover in the service worker (Tasks 16 and 17), behind one small adapter.
//
// The message shapes are declared here, locally, because Tasks 16/17 add the shared `RuntimeMessage` union
// (apps/extension/src/shared/messages.ts) in parallel; at merge this file switches to those types. Until a handler
// exists in the service worker, each call falls back to what the viewer page can do on its own.

/** The takeover messages this viewer sends (a subset of Task 16's `RuntimeMessage`). */
export type ViewerTakeoverMessage =
  | { type: 'takeover:prepare-fetch'; url: string } // → { referer: string | null }
  | { type: 'takeover:open-in-chrome'; url: string }
  | { type: 'takeover:open-file-settings' };

/**
 * Whether the viewer may show `source` where it is. A `file:` PDF is never shown inside another page's frame. The
 * takeover slice (Tasks 16/17) owns the full rule as `mayShowSourceHere` in its shared code; at merge this adapter calls
 * that instead of the fallback below.
 */
export function mayShowSourceHere(source: string): boolean {
  const framed = window.top !== window;
  return !(framed && /^file:/i.test(source));
}

/** How long the viewer waits for the service worker's Referer set-up before fetching anyway. */
const PREPARE_TIMEOUT_MS = 2000;

function send<R>(message: ViewerTakeoverMessage): Promise<R> {
  return chrome.runtime.sendMessage<ViewerTakeoverMessage, R>(message);
}

/**
 * Asks the service worker to send this tab's Referer with the viewer's fetch of `url` (Task 16's sticky Referer rule).
 * The reply's `referer` is the page the PDF was opened from, or null. Without an answer in time, it is null.
 */
export async function prepareFetch(url: string): Promise<{ referer: string | null }> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PREPARE_TIMEOUT_MS));
  try {
    const reply = await Promise.race([send<{ referer?: unknown } | undefined>({ type: 'takeover:prepare-fetch', url }), timeout]);
    return { referer: typeof reply?.referer === 'string' && reply.referer !== '' ? reply.referer : null };
  } catch {
    return { referer: null }; // no handler in the service worker
  }
}

/** Shows `url` in Chrome's own viewer, in this tab (Task 17: a one-time allow rule, so the takeover lets it through). */
export async function openInChromeViewer(url: string): Promise<void> {
  try {
    await send<unknown>({ type: 'takeover:open-in-chrome', url });
  } catch {
    location.assign(url); // no takeover handler: nothing would redirect this navigation back to us
  }
}

/** Opens this extension's settings page, where "Allow access to file URLs" is switched on. */
export async function openFileSettings(): Promise<void> {
  try {
    await send<unknown>({ type: 'takeover:open-file-settings' });
  } catch {
    await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  }
}
