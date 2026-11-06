// Enter on a hit in another document (or anywhere in the library): a new tab on the reading, at the right place.
//
// The saved copy is opened (`viewer.html?doc=<id>`), so a note can be shown and a dead link never lands on Chrome's error
// page; the viewer then offers "Open original link". A reading whose copy is not there opens from its last link instead,
// at the page; the words and the note cannot go with a link. A reading opened as such (no page given) is taken to its
// resume spot by the viewer itself (S16).
import type { DocumentId } from '@sop/core';
import { openBlobStore } from '../../store/blob-store';
import { buildViewerUrl, parseViewerUrl, VIEWER_PATH } from '../viewer-url';
import { shownTitle } from '../shown-title';
import { isOpenableUrl } from '../urls';
import type { PaletteStore, PaletteTarget } from './types';

/** The pdf's name for the header and the tab: its title (or its file name) with `.pdf`. */
function fileNameFor(title: string): string {
  return /\.pdf$/iu.test(title) ? title : `${title}.pdf`;
}

/** Joins the page number to a link, keeping no other fragment. */
function atPage(link: string, page: number | null): string {
  if (page === null) return link;
  const hash = link.indexOf('#');
  const base = hash < 0 ? link : link.slice(0, hash);
  return `${base}#page=${page}`;
}

/** The 1-based page a target opens on, or null to let the viewer decide (the top, or where the reader stopped). */
function pageFor(target: PaletteTarget): number | null {
  switch (target.kind) {
    case 'page':
      return target.pageIndex + 1;
    case 'note':
      return target.pageIndex === null ? null : target.pageIndex + 1;
    case 'reading':
      return null;
  }
}

/** Whether the copy is really in the extension's file storage (a row can say it is kept when the file is gone). */
async function copyIsHere(id: DocumentId): Promise<boolean> {
  try {
    return await (await openBlobStore()).has(id);
  } catch {
    return false;
  }
}

/**
 * A viewer tab that already shows reading `id` (TB6): its saved copy (`?doc=<id>`), or one of the links it was opened from.
 * Chrome tells an extension the addresses of its own pages without the "tabs" permission (`getContexts`), so nothing else
 * is read. null when no tab shows it.
 */
async function openTabOf(id: DocumentId, links: readonly string[]): Promise<{ tabId: number; windowId: number | undefined } | null> {
  try {
    const viewer = `${chrome.runtime.getURL(VIEWER_PATH)}`;
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    for (const c of contexts) {
      if (c.tabId < 0 || c.documentUrl === undefined || !c.documentUrl.startsWith(viewer)) continue;
      const p = parseViewerUrl(c.documentUrl);
      const base = (u: string) => u.split('#')[0];
      if (p.doc === id || (p.source !== null && links.some((l) => base(l) === base(p.source as string)))) return { tabId: c.tabId, windowId: c.windowId };
    }
  } catch {
    // no way to tell: a new tab opens, as before
  }
  return null;
}

/** Shows tab `tabId` and its window. `url`: where it should be (a reading opened at a place); without it the tab is left as it is. */
async function switchTo(open: { tabId: number; windowId: number | undefined }, url: string | null): Promise<boolean> {
  try {
    await chrome.tabs.update(open.tabId, { active: true, ...(url !== null ? { url } : {}) });
    if (open.windowId !== undefined && open.windowId >= 0) await chrome.windows.update(open.windowId, { focused: true });
    return true;
  } catch {
    return false; // the tab closed meanwhile: a new one opens
  }
}

/**
 * Opens `target` in a tab: the reading's open tab if it has one (TB6: a switch to it, and to the place when the hit names one),
 * else a new tab. Resolves with a plain sentence when it could not be opened (the reading is gone, or has
 * neither a saved copy nor a link), and null when it was.
 */
export async function openTargetInNewTab(target: PaletteTarget, store: PaletteStore): Promise<string | null> {
  const id: DocumentId = target.documentId;
  const doc = await store.getDocument(id).catch(() => null);
  if (doc === null) return 'That PDF isn’t in your library any more.';
  const locations = await store.listLocations(id).catch(() => []);
  const link = locations.reduce<(typeof locations)[number] | null>((best, l) => (best === null || l.lastSeen > best.lastSeen ? l : best), null)?.raw ?? null;
  const page = pageFor(target);
  if (doc.blobStored && (await copyIsHere(id))) {
    const url = buildViewerUrl({
      source: null,
      back: null,
      page,
      doc: id,
      name: fileNameFor(shownTitle(doc.title, link)),
      ...(target.kind === 'note' ? { note: target.threadId } : {}),
      ...(target.kind === 'page' && target.terms.length > 0 ? { q: target.terms.join(' ') } : {}),
    });
    const open = await openTabOf(id, locations.map((l) => l.raw));
    // A bare reading just switches (the tab is as the reader left it); a page or a note shows its place.
    if (open !== null && (await switchTo(open, target.kind === 'reading' ? null : url))) return null;
    await chrome.tabs.create({ url });
    return null;
  }
  if (link === null || !isOpenableUrl(link)) return 'This PDF has no saved copy and no link to open it from.';
  const open = await openTabOf(id, locations.map((l) => l.raw));
  if (open !== null && (await switchTo(open, target.kind === 'reading' ? null : atPage(link, page)))) return null;
  await chrome.tabs.create({ url: atPage(link, page) });
  return null;
}
