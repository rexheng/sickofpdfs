// Enter on a hit in another document (or anywhere in the library): a new tab on the reading, at the right place.
//
// The saved copy is opened (`viewer.html?doc=<id>`), so a note can be shown and a dead link never lands on Chrome's error
// page; the viewer then offers "Open original link". A reading whose copy is not there opens from its last link instead,
// at the page; the words and the note cannot go with a link. A reading opened as such (no page given) is taken to its
// resume spot by the viewer itself (S16).
import type { DocumentId } from '@sop/core';
import { openBlobStore } from '../../store/blob-store';
import { buildViewerUrl } from '../viewer-url';
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
 * Opens `target` in a new tab. Resolves with a plain sentence when it could not be opened (the reading is gone, or has
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
    await chrome.tabs.create({ url });
    return null;
  }
  if (link === null || !isOpenableUrl(link)) return 'This PDF has no saved copy and no link to open it from.';
  await chrome.tabs.create({ url: atPage(link, page) });
  return null;
}
