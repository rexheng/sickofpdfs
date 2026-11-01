// After a crash, the PDF tabs come back by themselves (crash-report.md, gap 2 of the Test build 2 triage; ruling R65).
//
// All the extension's pages share one renderer process. When it dies (a crash, "End process" in Chrome's task manager), every
// viewer tab dies with it, and so does the offscreen store document. Chrome then marks the extension "terminated": its pages
// are blocked (ERR_BLOCKED_BY_CLIENT), PDFs open in Chrome's own viewer, and Chrome shows the notification "sickofpdfs has
// crashed. Click this balloon to reload the extension." Chrome never reloads it by itself (only force-installed extensions).
//
// When the owner reloads it (that notification, or Reload on chrome://extensions), the service worker starts again. It then
// reloads every viewer tab whose page is dead: a crashed tab, or one that showed Chrome's "blocked" page meanwhile. Each tab
// opens at the page it showed (the viewer keeps `#page=N` in its address), keeps its own id (tab-presence.ts) and gets back
// the note it was typing (the draft keeper's journal). So the owner's way back is one click.
//
// Viewer tabs are known by the ids they note themselves (shared/viewer-tabs.ts): without the `tabs` permission the worker
// cannot read the address of its own pages. A tab whose address it can read is a web or file page, so no longer a viewer.
//
// A tab is reloaded at most once in RELOAD_GUARD_MS: a PDF that crashes the renderer every time must not trap the owner in a
// loop of crashes. The guard keeps tab ids and times only, nothing about the PDFs.

import { VIEWER_TAB_PREFIX, viewerTabKey } from '../shared/viewer-tabs';

const GUARD_KEY = 'crashReloads';
export const RELOAD_GUARD_MS = 5 * 60_000;
/** A dead page is looked at twice, this far apart: a tab that is still starting has no page yet either. */
const RECHECK_MS = 1500;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The noted viewer tabs that are loaded, not discarded, and have no live page of ours. Forgets the notes that are stale. */
async function deadViewerTabs(): Promise<chrome.tabs.Tab[]> {
  const noted = Object.keys(await chrome.storage.local.get(null))
    .filter((k) => k.startsWith(VIEWER_TAB_PREFIX))
    .map((k) => Number(k.slice(VIEWER_TAB_PREFIX.length)))
    .filter((id) => Number.isInteger(id));
  if (noted.length === 0) return [];
  const live = new Set((await chrome.runtime.getContexts({ contextTypes: ['TAB'] })).map((c) => c.tabId));
  const dead: chrome.tabs.Tab[] = [];
  const stale: string[] = [];
  for (const id of noted) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    // Gone, or showing a page whose address we can read (a web or file page): not a viewer any more.
    if (!tab || tab.url !== undefined) stale.push(viewerTabKey(id));
    else if (!live.has(id) && tab.status === 'complete' && !tab.discarded) dead.push(tab);
  }
  if (stale.length > 0) await chrome.storage.local.remove(stale);
  return dead;
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

/** Call once, synchronously, when the service worker starts. */
export function installCrashRecovery(): void {
  chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.local.remove(viewerTabKey(tabId)).catch(() => undefined));
  reloadDeadViewers().catch((error: unknown) => console.error('sickofpdfs: could not reopen the PDF tabs after a crash', error));
}
