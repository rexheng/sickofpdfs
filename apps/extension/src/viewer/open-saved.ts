// Opening the saved copy of a reading (`viewer.html?doc=<id>`, S15): the library, the search palette and a note's link open a
// reading from the copy the extension keeps, so a dead link or a deleted file does not matter. The copy is read from the
// private file storage (the blob store) and goes through the same path as a file the person picked, so it is hashed as it
// is read, its notes are found by that hash, and nothing is fetched.
import { PdfLoadError } from '@sop/viewer';
import type { DocumentId } from '@sop/core';
import type { Sha256 } from '@sop/core/ids';
import { openBlobStore } from '../store/blob-store';
import { connectStore } from '../store/client';
import { isOpenableUrl } from '../shared/urls';
import type { ViewerParams } from '../shared/viewer-url';
import { isIncognito } from './incognito';
import { type OpenDocumentDeps, type OpenOutcome, openPickedFile } from './open-document';
import { atPage } from './open-in-chrome';

/**
 * The library has no copy of this reading (it was never kept, or it was removed). The error card says so in plain words
 * (ui/LoadErrorCard.tsx). It is a network-coded load error only so that nothing else in the viewer takes it for a file
 * that Chrome would not let it read.
 */
export class SavedCopyMissingError extends PdfLoadError {
  constructor() {
    super('network');
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;

/** A file name from an address: no folders, no control characters, at most 255 characters. Null when nothing is left. */
function cleanName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const base = (name.split(/[/\\]/u).pop() ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 255);
  return base === '' ? null : base;
}

/** The name a saved copy's address gives it (for the header and the tab while it opens), or null for any other address. */
export function savedCopyName(p: ViewerParams): string | null {
  return (p.doc ?? null) === null ? null : cleanName(p.name);
}

/** The link a reading was last opened from, or null (none, no library here, or the library would not answer). */
async function lastLinkOf(id: string): Promise<string | null> {
  if (isIncognito()) return null;
  const store = await connectStore().catch(() => null);
  if (store === null) return null;
  try {
    const places = await store.listLocations(id as DocumentId);
    const link = places.reduce<(typeof places)[number] | null>((best, l) => (best === null || l.lastSeen > best.lastSeen ? l : best), null)?.raw ?? null;
    return link !== null && isOpenableUrl(link) ? link : null;
  } catch {
    return null;
  } finally {
    store.close();
  }
}

/** Sends this tab to `link`, where the takeover opens it in the viewer (or its error card, if the link is dead). */
async function goToLink(link: string): Promise<boolean> {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id === undefined) return false;
    await chrome.tabs.update(tab.id, { url: link });
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens the saved copy that `p.doc` names. When the copy is not there, the reading's last link is opened instead, in this
 * tab (a dead link then shows the viewer's error card, never Chrome's page); with no link either, the error card says the
 * copy is missing. Never rejects: every failure is an outcome.
 */
export async function openSavedCopy(p: ViewerParams, deps: OpenDocumentDeps): Promise<OpenOutcome> {
  const id = p.doc ?? '';
  if (!HEX64.test(id)) return { kind: 'error', error: new PdfLoadError('network') };
  // No private file storage here (a window that keeps nothing) is the same as no copy.
  const copy = await openBlobStore()
    .then((blobs) => blobs.get(id as Sha256))
    .catch(() => null);
  if (copy === null) {
    const link = await lastLinkOf(id);
    // Nothing is shown while the tab moves on; `bounced` is the viewer's "this tab is leaving" state.
    if (link !== null && (await goToLink(atPage(link, p.page ?? undefined)))) return { kind: 'bounced' };
    return { kind: 'error', error: new SavedCopyMissingError() };
  }
  // The copy's own file name is its hash; the address carries the reading's name for the header and the tab.
  const named = new File([copy], cleanName(p.name) ?? 'Saved PDF.pdf', { type: 'application/pdf' });
  return openPickedFile(named, deps);
}
