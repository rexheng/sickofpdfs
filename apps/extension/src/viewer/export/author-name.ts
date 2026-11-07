// The owner's name on exported notes (/T: Foxit and Acrobat show it beside each note). Kept in the synced setting
// `export.authorName` (plan section 9's settings keys), so it is asked once, on the first "Download with notes", and
// Settings → Download with notes changes it. The value belongs to no PDF: asking for it, or keeping it, says nothing about what was
// opened. Without a library (it could not be reached) the name lives in this tab only.
import type { StoreClient } from '../../store/client';

export const AUTHOR_NAME_KEY = 'export.authorName';
/** The longest name kept (a name, not a note). */
export const AUTHOR_NAME_MAX = 80;

/** A name as kept: one line, trimmed, at most AUTHOR_NAME_MAX chars. */
export function cleanAuthorName(v: string): string {
  return v.replace(/\s+/gu, ' ').trim().slice(0, AUTHOR_NAME_MAX);
}

/** The name given before, '' for "no name" (asked, left blank), or null when it was never asked. */
export async function readAuthorName(store: Pick<StoreClient, 'getSetting'> | null): Promise<string | null> {
  if (store === null) return tabName;
  try {
    const v = await store.getSetting(AUTHOR_NAME_KEY);
    return typeof v === 'string' ? cleanAuthorName(v) : null;
  } catch {
    return tabName;
  }
}

/** Keeps the name (in the library's settings; in this tab only when there is none). A failed write is not fatal: the export goes on. */
export async function writeAuthorName(store: Pick<StoreClient, 'setSetting'> | null, name: string): Promise<void> {
  tabName = cleanAuthorName(name);
  if (store === null) return;
  try {
    await store.setSetting(AUTHOR_NAME_KEY, tabName);
  } catch {
    // kept for this tab: the next tab asks again
  }
}

let tabName: string | null = null;
