// A reading's page order (R108). The owner can drag pages into a new order in the viewer's thumbnails. The file is never
// changed: the order is one list kept beside it, `pageOrder`, the original page index shown at each position (null: the
// file's own order). Everything stored about a page (marks, comments, recognised text, figures, citations) keeps its
// original page index; only what the owner sees (page numbers, the order of the pages, of the notes, of the hits) goes
// through this mapping. Pure: the extension, the phone app and sync share it.

/** The original page index shown at each position, or null for the file's own order. */
export type PageOrder = readonly number[] | null;

/** The settings row a saved reading keeps its order in: `pageOrder.of.<sha>` (like the courses' `course.of.<sha>`). */
export const PAGE_ORDER_KEY_PREFIX = 'pageOrder.of.';

/** The settings key of a reading's page order. */
export const pageOrderKey = (documentId: string): string => `${PAGE_ORDER_KEY_PREFIX}${documentId}`;

/** The reading a settings key names, or null when it is not a page order key. */
export function documentOfPageOrderKey(key: string): string | null {
  return key.startsWith(PAGE_ORDER_KEY_PREFIX) && key.length > PAGE_ORDER_KEY_PREFIX.length ? key.slice(PAGE_ORDER_KEY_PREFIX.length) : null;
}

/**
 * `v` as the order of a document of `pageCount` pages: every page exactly once. Null for anything else (another page
 * count, a repeat, a gap, not numbers) and for the file's own order, so a stored value can never hide or repeat a page.
 */
export function cleanPageOrder(v: unknown, pageCount: number): number[] | null {
  if (!Array.isArray(v) || v.length !== pageCount || pageCount <= 0) return null;
  const seen = new Uint8Array(pageCount);
  let identity = true;
  for (let k = 0; k < pageCount; k++) {
    const p: unknown = v[k];
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p >= pageCount || seen[p] === 1) return null;
    seen[p] = 1;
    if (p !== k) identity = false;
  }
  return identity ? null : (v as number[]).slice();
}

/** Two orders are the same (null and the file's own order are the same). */
export function samePageOrder(a: PageOrder, b: PageOrder): boolean {
  if (a === b) return true;
  const n = Math.max(a?.length ?? 0, b?.length ?? 0);
  for (let k = 0; k < n; k++) if ((a?.[k] ?? k) !== (b?.[k] ?? k)) return false;
  return true;
}

const inverses = new WeakMap<readonly number[], Int32Array>();

/** positions[page]: where each page is shown. Kept per order, so a lookup is O(1) after the first. */
function positionsOf(order: readonly number[]): Int32Array {
  let inv = inverses.get(order);
  if (inv === undefined) {
    inv = new Int32Array(order.length);
    for (let k = 0; k < order.length; k++) inv[order[k]] = k;
    inverses.set(order, inv);
  }
  return inv;
}

/** Where page `page` (an original index) is shown, 0-based. A page outside the order is where the file has it. */
export function positionOfPage(order: PageOrder, page: number): number {
  if (order === null || page < 0 || page >= order.length) return page;
  return positionsOf(order)[page];
}

/** The page (an original index) shown at `position`. */
export function pageAtPosition(order: PageOrder, position: number): number {
  if (order === null || position < 0 || position >= order.length) return position;
  return order[position];
}

/** The page number the owner sees for page `page` (an original index), 1-based. */
export function shownPageNumber(order: PageOrder, page: number): number {
  return positionOfPage(order, page) + 1;
}

/** Compares two pages (original indices) by where they are shown. */
export function byShownPosition(order: PageOrder): (a: number, b: number) => number {
  if (order === null) return (a, b) => a - b;
  const pos = positionsOf(order);
  return (a, b) => (pos[a] ?? a) - (pos[b] ?? b);
}

/** The pages in the order they are shown. */
export function shownPages(order: PageOrder, pageCount: number): number[] {
  return order === null ? Array.from({ length: pageCount }, (_, k) => k) : order.slice();
}

/** The page shown `steps` places after page `page` (before, when negative), clamped to the first and the last. */
export function pageAfter(order: PageOrder, pageCount: number, page: number, steps: number): number {
  if (pageCount <= 0) return 0;
  const at = Math.min(pageCount - 1, Math.max(0, positionOfPage(order, page) + steps));
  return pageAtPosition(order, at);
}

/**
 * Moves `pages` (original indices; repeats and pages outside the document are ignored) so they sit together, in the
 * order they are shown now, just before the page shown at position `before` (0 the start, `pageCount` the end). Returns
 * the new order, null when that is the file's own order.
 */
export function movePages(order: PageOrder, pageCount: number, pages: readonly number[], before: number): number[] | null {
  const shown = shownPages(order, pageCount);
  const moving = new Set(pages.filter((p) => Number.isInteger(p) && p >= 0 && p < pageCount));
  if (moving.size === 0) return order === null ? null : order.slice();
  const at = Math.min(pageCount, Math.max(0, Math.round(before)));
  const block = shown.filter((p) => moving.has(p));
  const rest = shown.filter((p) => !moving.has(p));
  let insert = 0;
  for (let k = 0; k < at; k++) if (!moving.has(shown[k])) insert++;
  const next = [...rest.slice(0, insert), ...block, ...rest.slice(insert)];
  return cleanPageOrder(next, pageCount);
}

/**
 * Alt+Up and Alt+Down: `pages` move one place up (-1) or down (1) as a block (pages that were apart are gathered at the
 * first of them). At the start or the end they stay. Returns the new order, null for the file's own order.
 */
export function nudgePages(order: PageOrder, pageCount: number, pages: readonly number[], dir: -1 | 1): number[] | null {
  const at = pages.filter((p) => Number.isInteger(p) && p >= 0 && p < pageCount).map((p) => positionOfPage(order, p));
  if (at.length === 0) return order === null ? null : order.slice();
  const first = Math.min(...at);
  const last = Math.max(...at);
  const before = dir < 0 ? Math.max(0, first - 1) : Math.min(pageCount, last + 2);
  return movePages(order, pageCount, pages, before);
}
