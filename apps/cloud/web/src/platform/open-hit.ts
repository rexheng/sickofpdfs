// The web's version of apps/extension/src/shared/palette/open-hit.ts (swapped in by vite.config.ts). Enter on a search hit, or a
// click on a note, goes to the reading's page in the web library: at the page that was found, and at the note.
import type { PaletteStore, PaletteTarget } from '@ext/shared/palette/types';
import { goTo, readingHref } from './web-route';

export async function openTargetInNewTab(target: PaletteTarget, store: PaletteStore): Promise<string | null> {
  const doc = await store.getDocument(target.documentId).catch(() => null);
  if (doc === null) return 'That PDF isn’t in your library any more.';
  const page = target.kind === 'page' ? target.pageIndex + 1 : target.kind === 'note' && target.pageIndex !== null ? target.pageIndex + 1 : null;
  goTo(readingHref(target.documentId, { page, note: target.kind === 'note' ? target.threadId : null }));
  return null;
}
