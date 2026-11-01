// A stand-in for S13's session wiring (annotations/wire.ts), so comments work in this build before S13 merges.
//
// DELETE THIS FILE when S13 has merged: NotesLayer then takes S13's session through its `wiring` prop, and there must
// be one session per document, shared by the marks, the comments and the notes panel.
//
// It writes nothing. Until Task 30's save decision lands, a mark or note cannot be stored, because its PDF has no
// document row yet (plan section 2, S13): the session is memory-only, and so are its drafts. The one question that
// decides that is `saveDecision()` below; Task 30 replaces it.
import { buildTextAnchor, type CharPos, type MarkColor, type NormRect } from '@sop/core';
import { markLineRects, pdfRectToNorm, type CharRange, type PageTextProviderImpl } from '@sop/viewer';
import type { AnchorContext, SaveController } from '../annotations/boundary';
import { createDraftKeeper } from '../annotations/drafts';
import { createAnnotationSession } from '../annotations/session';
import { createTabPresence } from '../annotations/tab-presence';
import { isIncognito } from '../incognito';
import type { OpenedDocument } from '../open-document';
import type { NotesWiring } from './wiring';

/**
 * Is this document saved, and may notes be written? Not yet: Task 30 brings the save decision (the first mark saves a
 * "not sure" PDF, ask first on "not learning"). Null means memory-only: notes live in this tab until it closes.
 */
function saveDecision(): SaveController | null {
  return null;
}

/** The text anchor for the selected ranges: the quote with its context, the positions and the line rects (R44). */
export async function makeTextAnchor(doc: OpenedDocument, text: PageTextProviderImpl, ranges: CharRange[]) {
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.pageIndex - b.pageIndex || a.start - b.start);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) throw new Error('makeTextAnchor: nothing selected');
  const pages = [...new Set(sorted.map((r) => r.pageIndex))];
  const raw = new Map(await Promise.all(pages.map(async (p) => [p, await text.rawText(p)] as const)));
  const rects = await Promise.all(
    sorted.map(async (r) => {
      const size = doc.open.pages[r.pageIndex];
      const lines = await markLineRects(text, r.pageIndex, r.start, r.end - r.start);
      return { page: r.pageIndex, rects: lines.map((l): NormRect => pdfRectToNorm(l, size)) };
    }),
  );
  const start: CharPos = { page: first.pageIndex, index: first.start };
  const end: CharPos = { page: last.pageIndex, index: last.end };
  return buildTextAnchor({ text: (p) => raw.get(p) ?? '', start, end, rects });
}

export function createStandInWiring(o: { doc: OpenedDocument; pageText: PageTextProviderImpl }): NotesWiring & { dispose(): void } {
  const presence = createTabPresence();
  const save = saveDecision();
  const memoryOnly = () => save === null || save.state.kind !== 'saved';
  const keeper = createDraftKeeper({ store: null, presence, memoryOnly });
  const anchors: AnchorContext = {
    pageCount: o.doc.open.pageCount,
    text: o.pageText,
    figures: () => Promise.resolve([]),
    dHash: () => Promise.resolve(''),
  };
  const session = createAnnotationSession({
    store: null,
    save,
    anchors,
    drafts: keeper,
    presence,
    makeTextAnchor: (ranges) => makeTextAnchor(o.doc, o.pageText, ranges),
    documentId: () => null,
    incognito: isIncognito(),
    now: () => Date.now(),
  });
  return {
    session,
    flushDrafts: () => void keeper.flush().catch(() => undefined),
    highlightColor: (): MarkColor => 1,
    makeTextAnchor: (ranges) => makeTextAnchor(o.doc, o.pageText, ranges),
    dispose() {
      session.dispose();
      keeper.dispose();
      presence.close();
    },
  };
}
