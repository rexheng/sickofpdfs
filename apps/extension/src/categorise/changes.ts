// Which store changes the categoriser has work for. Its own small file: the offscreen document's host (host.ts) reads it to know when
// to start the worker again, without loading the categoriser itself on the offscreen document's thread.
import { CATEGORISER_TAB, type StoreChange } from '../store/change-bus';

/** Pages of text the vector is made from (the store's INPUT_PAGES). */
export const VECTOR_PAGES = 3;

/**
 * A change the categoriser has work for: a reading added, changed or gone, the first pages of its text, or the owner's tags. Its own
 * writes are not. The host starts the worker again on one of these; the controller looks at the same ones.
 */
export function mattersToCategoriser(c: StoreChange): boolean {
  if (c.tabId === CATEGORISER_TAB) return false;
  if (c.table === 'documents') return true;
  // Only the first pages make the vector; the later pages of a long PDF arriving one by one do not matter.
  if (c.table === 'page_text') return c.op === 'delete' || c.ids.length === 0 || c.ids.some((id) => Number(id.slice(id.lastIndexOf(':') + 1)) < VECTOR_PAGES);
  return c.table === 'reading_tags' || c.table === 'tags' || c.table === 'auto_tag_removed';
}
