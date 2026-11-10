// The search box (Ctrl+K and the search bar) on the web. Readings and notes are found in this tab's copy of the library, as in
// Chrome. Page text is not copied into the tab (it can be large), so the pages are found by the cloud's own search
// (`GET /api/search?kinds=page`, CL5), which searches every page of every reading. The two answers are merged.
import type { DocumentId } from '@sop/core';
import type { PaletteStore } from '@ext/shared/palette/types';
import type { SearchHit } from '@ext/store/library-api';
import type { StoreClient } from '@ext/store/client';
import { api } from './api';

interface CloudPageHit {
  kind: 'page';
  documentId: string;
  pageIndex: number;
  snippet: string;
  rank: number;
}

/** Bold for the typed words, as the extension's own snippets mark them (`<b>…</b>`). */
function markWords(snippet: string, text: string): string {
  const clean = snippet.replace(/<\/?b>/giu, '');
  const words = [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))].sort((a, b) => b.length - a.length);
  if (words.length === 0) return clean;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  return clean.replace(new RegExp(`(${escaped.join('|')})`, 'giu'), '<b>$1</b>');
}

export function remotePalette(store: StoreClient): PaletteStore {
  return {
    getDocument: (id) => store.getDocument(id),
    listLocations: (id) => store.listLocations(id),
    listDocuments: (q) => store.listDocuments(q),
    async search(q) {
      const wantsPages = q.kinds === undefined || q.kinds.includes('page');
      const localKinds = (q.kinds ?? ['reading', 'page', 'note']).filter((k) => k !== 'page');
      const [local, pages] = await Promise.all([
        localKinds.length > 0 ? store.search({ ...q, kinds: localKinds }) : Promise.resolve([] as SearchHit[]),
        wantsPages && q.text.trim() !== ''
          ? api<CloudPageHit[]>(`/api/search?${new URLSearchParams({ q: q.text, kinds: 'page', limit: String(Math.min(50, Math.max(1, q.limit))), ...(q.documentId ? { doc: q.documentId } : {}) })}`).catch(() => [])
          : Promise.resolve([]),
      ]);
      // Only pages of readings this library shows (the filters, Trash): the tab's copy decides.
      const shown = new Set<string>();
      for (const id of new Set(pages.map((p) => p.documentId))) {
        const doc = await store.getDocument(id as DocumentId).catch(() => null);
        if (doc !== null && doc.deletedAt === null) shown.add(id);
      }
      const pageHits: SearchHit[] = pages
        .filter((p) => p.kind === 'page' && shown.has(p.documentId))
        .map((p) => ({ kind: 'page', documentId: p.documentId as DocumentId, pageIndex: p.pageIndex, snippet: markWords(p.snippet, q.text), rank: p.rank }));
      return [...local, ...pageHits];
    },
  };
}
