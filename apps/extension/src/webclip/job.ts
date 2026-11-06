// "Save this page to library" (spec R103): how the action menu hands a save to the tab that makes the PDF.
//
// The menu reads the article (it closes as soon as the owner looks away, so it does only that), then opens `save-page.html`
// next to the page, which reads the pictures, makes the PDF, saves it and shows the reading. The article goes across in
// chrome.storage.session: memory only, never written to disk, gone when the browser closes, and not readable by content
// scripts (its default access level). The saving tab takes it out at once.
import type { DocumentId } from '@sop/core';
import type { Article } from './article';

export interface PageJob {
  /** The tab the page is in: the pictures are read from it. */
  tabId: number;
  article: Article;
  textHash: string;
  earlier: DocumentId | null;
  createdAt: number;
}

export const SAVE_PAGE_PATH = 'save-page.html';
const PREFIX = 'webclip-job:';
/** A job nobody picked up in this long is removed (a tab that never opened). */
const STALE_MS = 10 * 60_000;

/** Keeps the job and answers its id. Older jobs nobody took are removed first. */
export async function putJob(job: PageJob): Promise<string> {
  const all = await chrome.storage.session.get(null);
  const stale = Object.entries(all)
    .filter(([k, v]) => k.startsWith(PREFIX) && !(typeof (v as PageJob | null)?.createdAt === 'number' && job.createdAt - (v as PageJob).createdAt < STALE_MS))
    .map(([k]) => k);
  if (stale.length > 0) await chrome.storage.session.remove(stale);
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [PREFIX + id]: job });
  return id;
}

/** Takes the job out (it can be taken once); null when there is none. */
export async function takeJob(id: string): Promise<PageJob | null> {
  if (!/^[0-9a-f-]{36}$/u.test(id)) return null;
  const key = PREFIX + id;
  const job = (await chrome.storage.session.get(key))[key] as PageJob | undefined;
  await chrome.storage.session.remove(key);
  return job ?? null;
}
