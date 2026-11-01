// After a crash, the PDF tabs come back by themselves (crash-report.md, gap 2 of the Test build 2 triage).
//
// All the extension's pages share one renderer process. When it dies (a crash, "End process" in Chrome's task manager), every
// viewer tab dies with it, and so does the offscreen store document. Chrome then marks the extension "terminated": its pages
// are blocked (ERR_BLOCKED_BY_CLIENT), PDFs open in Chrome's own viewer, and Chrome shows the notification "sickofpdfs has
// crashed. Click this balloon to reload the extension." Chrome never reloads it by itself (only force-installed extensions).
//
// When the owner reloads it (that notification, or Reload on chrome://extensions), the service worker starts again. It then
// reloads every viewer tab whose page is dead: a crashed tab, or one that showed Chrome's "blocked" page meanwhile. Each tab
// opens at the page it showed (the viewer keeps `#page=N` in its address) and gets back the note being typed (the draft
// keeper's journal). So the owner's way back is one click.
//
// A tab is reloaded at most once in RELOAD_GUARD_MS: a PDF that crashes the renderer every time must not trap the owner in a
// loop of crashes. The guard keeps tab ids and times only, nothing about the PDFs.

import { VIEWER_PATH } from '../shared/viewer-url';

const GUARD_KEY = 'crashReloads';
export const RELOAD_GUARD_MS = 5 * 60_000;
/** A dead page is looked at twice, this far apart: a tab that is still starting has no page yet either. */
const RECHECK_MS = 1500;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Viewer tabs that are loaded, not discarded, and have no live page of ours. */
async function deadViewerTabs(): Promise<chrome.tabs.Tab[]> {
  const viewer = chrome.runtime.getURL(VIEWER_PATH);
  const tabs = (await chrome.tabs.query({})).filter((t) => t.id !== undefined && t.url?.startsWith(viewer) === true && t.status === 'complete' && !t.discarded);
  if (tabs.length === 0) return [];
  const live = new Set((await chrome.runtime.getContexts({ contextTypes: ['TAB'] })).map((c) => c.tabId));
  return tabs.filter((t) => !live.has(t.id!));
}

async function reloadDeadViewers(): Promise<void> {
  const first = await deadViewerTabs();
  if (first.length === 0) return;
  await sleep(RECHECK_MS);
  const again = new Set((await deadViewerTabs()).map((t) => t.id));
  const dead = first.filter((t) => again.has(t.id));
  if (dead.length === 0) return;

  const now = Date.now();
  const stored: unknown = (await chrome.storage.local.get(GUARD_KEY))[GUARD_KEY];
  const guard: Record<string, number> = {};
  if (typeof stored === 'object' && stored !== null) {
    for (const [id, at] of Object.entries(stored as Record<string, unknown>)) if (typeof at === 'number' && now - at < RELOAD_GUARD_MS) guard[id] = at;
  }
  // The tab in front first, so the one the owner is looking at comes back first.
  const order = [...dead].sort((a, b) => Number(b.active) - Number(a.active));
  const reloading: number[] = [];
  for (const t of order) {
    if (guard[String(t.id)] !== undefined) continue;
    guard[String(t.id)] = now;
    reloading.push(t.id!);
  }
  await chrome.storage.local.set({ [GUARD_KEY]: guard });
  for (const id of reloading) await chrome.tabs.reload(id).catch(() => undefined); // the tab may have been closed meanwhile
}

/** Call once when the service worker starts. */
export function installCrashRecovery(): void {
  reloadDeadViewers().catch((error: unknown) => console.error('sickofpdfs: could not reopen the PDF tabs after a crash', error));
}
