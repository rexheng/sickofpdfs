// Change events: after every committed write the store worker posts one `StoreChange` per table on a BroadcastChannel,
// and every open tab of the extension hears it. Events carry ids only, never row content. Unsent drafts publish nothing.
import type { DocumentId, TabId } from '@sop/core';

export const CHANGES_CHANNEL = 'sop-changes';

/** Every table a change event can name (contracts §4). The ladder reserves `page_ocr` for Phase 7. */
export type StoreTable =
  | 'documents'
  | 'aliases'
  | 'locations'
  | 'page_text'
  | 'history'
  | 'marks'
  | 'threads'
  | 'comments'
  | 'settings'
  | 'page_figures'
  | 'page_ocr';

const STORE_TABLES: ReadonlySet<string> = new Set<StoreTable>([
  'documents',
  'aliases',
  'locations',
  'page_text',
  'history',
  'marks',
  'threads',
  'comments',
  'settings',
  'page_figures',
  'page_ocr',
]);

/**
 * One committed change (contracts §4). `ids` are the changed rows' ids (for page text and figures, `<documentId>:<pageIndex>`).
 * `documentId` names the document the rows belong to, so a viewer can listen for its own document only. `tabId` is the
 * writing tab, so that tab can ignore its own echo. `origin` is set for rows applied by sync or a restore.
 */
export interface StoreChange {
  table: StoreTable;
  ids: string[];
  op: 'upsert' | 'delete';
  documentId?: DocumentId;
  origin?: 'tab' | 'sync' | 'restore';
  tabId?: TabId;
}

/** True for a well-formed change event. Anything else arriving on the channel is ignored. */
export function isStoreChange(x: unknown): x is StoreChange {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as Record<string, unknown>;
  if (typeof c.table !== 'string' || !STORE_TABLES.has(c.table)) return false;
  if (!Array.isArray(c.ids) || !c.ids.every((id) => typeof id === 'string')) return false;
  if (c.op !== 'upsert' && c.op !== 'delete') return false;
  if (c.documentId !== undefined && typeof c.documentId !== 'string') return false;
  if (c.origin !== undefined && c.origin !== 'tab' && c.origin !== 'sync' && c.origin !== 'restore') return false;
  if (c.tabId !== undefined && typeof c.tabId !== 'string') return false;
  return true;
}

/** The store worker's publisher: posts each change on the channel. It never throws; a lost event only delays other tabs. */
export function createChangePublisher(channelName: string = CHANGES_CHANNEL): { publish(c: StoreChange): void; close(): void } {
  const channel = new BroadcastChannel(channelName);
  return {
    publish(c) {
      try {
        channel.postMessage({ ...c, ids: [...c.ids] });
      } catch {
        // The write is committed. Other tabs see it on their next read.
      }
    },
    close: () => channel.close(),
  };
}

/** Listens for change events. Returns the function that stops listening. */
export function subscribeChanges(cb: (c: StoreChange) => void, channelName: string = CHANGES_CHANNEL): () => void {
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = (e: MessageEvent) => {
    if (!isStoreChange(e.data)) return;
    try {
      cb(e.data);
    } catch (error) {
      console.error('sickofpdfs: a store change listener failed', error);
    }
  };
  return () => channel.close();
}
