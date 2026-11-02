// Going to a search hit inside the document that is open (S15), and showing what an address asked for when a saved copy
// opens (`?doc=…&note=…&q=…#page=N`).
//
// - A page hit goes to the page and brings the first of the typed words into view: the whole phrase if it is on the page,
//   else the first word that is (`PageTextProvider.search`). The words are picked out for a moment (hit-flash.tsx).
// - A note hit makes the note active and shows its place, as the notes panel does.
// - A jump made from the palette goes through the jump history (Task 24), so it is one step and Back returns to where the
//   reader was. The jump an address asks for at open is not a step of its own: there is nothing to go back to.
import type { DocumentId, ThreadId } from '@sop/core';
import { goToTarget, type JumpHistory, type PageSize, type PdfRect, pdfRectToNorm, type SearchHit, viewPosition, type ViewerStore } from '@sop/viewer';
import type { PageListApi } from '@sop/viewer/react';
import { type RefObject, useEffect, useRef } from 'react';
import { queryTerms } from '../shared/palette/query';
import type { PaletteTarget } from '../shared/palette/types';
import type { ViewerParams } from '../shared/viewer-url';
import type { AnnotationSession } from './annotations/session';
import { hitFlash } from './hit-flash';
import { listNotes, type NoteSpot } from './notes-panel/model';
import { jumpTarget } from './notes-panel/navigate';
import { notesPanel } from './notes-panel/panel-state';

/** The page text this file reads: search and rects. */
export interface HitText {
  search(pageIndex: number, query: string, o: { matchCase: boolean; wholeWord: boolean }): Promise<SearchHit[]>;
  rects(pageIndex: number, start: number, count: number): Promise<PdfRect[]>;
}

export interface HitJumperDeps {
  api: RefObject<PageListApi | null>;
  text: HitText;
  pages: PageSize[];
  jumps: JumpHistory;
  view: ViewerStore;
  /** The notes of this document; null in Incognito (there are none). */
  session: AnnotationSession | null;
  /** The library id of the open document, while it is saved. */
  documentId(this: void): DocumentId | null;
}

export interface JumpOptions {
  /** Default true: the jump is one step of the page's history. False moves the view with no step (used at open). */
  history?: boolean;
}

export interface HitJumper {
  documentId(this: void): DocumentId | null;
  /** Goes to page `pageIndex`, and to the first of `terms` on it. False when the page does not exist. */
  toPage(pageIndex: number, terms: readonly string[], o?: JumpOptions): Promise<boolean>;
  /** Makes the note active and shows its place. False when this document has no such note. */
  toNote(threadId: ThreadId, o?: JumpOptions): Promise<boolean>;
  /** The hit the palette chose, in this document. False when it could not be shown. */
  go(target: PaletteTarget): Promise<boolean>;
}

/** The union of rects, or null for none. */
function bounds(rects: readonly PdfRect[]): PdfRect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const searchPage = (text: HitText, pageIndex: number, query: string): Promise<SearchHit[]> =>
  text.search(pageIndex, query, { matchCase: false, wholeWord: false }).catch((): SearchHit[] => []);

/** Words this close to the first one (in chars) are picked out with it. */
const NEAR_CHARS = 160;
/** At most this many of the typed words are looked for. */
const MOST_TERMS = 6;

/**
 * The first place on the page where the typed words are: all of them together if they are (that is the one hit), else the
 * first word that is, with each of the other words that is close to it, so the line the reader is looking for is picked out.
 */
async function hitsFor(text: HitText, pageIndex: number, terms: readonly string[]): Promise<SearchHit[]> {
  if (terms.length > 1) {
    const whole = (await searchPage(text, pageIndex, terms.join(' ')))[0];
    if (whole !== undefined) return [whole];
  }
  for (const [i, term] of terms.slice(0, MOST_TERMS).entries()) {
    const anchor = (await searchPage(text, pageIndex, term))[0];
    if (anchor === undefined) continue;
    const found = [anchor];
    for (const other of terms.slice(i + 1, MOST_TERMS)) {
      const near = (await searchPage(text, pageIndex, other))
        .filter((h) => Math.abs(h.start - anchor.start) <= NEAR_CHARS && !found.some((f) => h.start < f.start + f.count && f.start < h.start + h.count))
        .sort((a, b) => Math.abs(a.start - anchor.start) - Math.abs(b.start - anchor.start))[0];
      if (near !== undefined) found.push(near);
    }
    return found;
  }
  return [];
}

export function createHitJumper(d: HitJumperDeps): HitJumper {
  /** Moves the view so `spot` is a quarter of the way down it. */
  const show = (spot: NoteSpot, history: boolean): void => {
    const api = d.api.current;
    if (api === null) return;
    const target = jumpTarget(spot, d.pages, api);
    if (history) d.jumps.jumpTo(target, viewPosition(api, d.view.get().scale));
    else void goToTarget(api, d.pages, target);
  };

  const toPage: HitJumper['toPage'] = async (pageIndex, terms, o = {}) => {
    const page = d.pages[pageIndex];
    if (page === undefined || d.api.current === null) return false;
    const found = await hitsFor(d.text, pageIndex, terms);
    // The view goes to the first word that was found; the page's top when none was.
    let spot: NoteSpot = { pageIndex, x: 0, y: 0 };
    const first = found[0];
    if (first !== undefined) {
      const where = bounds(await d.text.rects(pageIndex, first.start, first.count).catch((): PdfRect[] => []));
      if (where !== null) {
        const norm = pdfRectToNorm(where, page);
        spot = { pageIndex, x: norm[0], y: norm[1] };
      }
    }
    show(spot, o.history !== false);
    if (found.length > 0) hitFlash.show({ pageIndex, ranges: found.map((h) => ({ start: h.start, count: h.count })) });
    return true;
  };

  const toNote: HitJumper['toNote'] = (threadId, o = {}) => {
    const session = d.session;
    if (session === null) return Promise.resolve(false);
    const all = listNotes(session.state());
    const entry = [...all.placed, ...all.unplaced].find((e) => e.id === threadId);
    if (entry === undefined) return Promise.resolve(false);
    // Leaving the card that was open, as the notes panel does: its typed text is sent, an empty box is dropped.
    const was = session.state().active;
    if (was !== null && was !== threadId) {
      for (const draft of session.state().drafts) if (draft.threadId === was) void (draft.body.trim() === '' ? session.cancel(draft.id) : session.send(draft.id));
    }
    session.setActive(threadId);
    if (entry.spot !== null) show(entry.spot, o.history !== false);
    else notesPanel.setOpen(true); // a note on the whole document, or one that could not be placed, is in the panel
    return Promise.resolve(true);
  };

  return {
    documentId: d.documentId,
    toPage,
    toNote,
    async go(target) {
      switch (target.kind) {
        case 'reading':
          return true; // it is open already
        case 'page':
          return toPage(target.pageIndex, target.terms);
        case 'note':
          return (await toNote(target.threadId)) || (target.pageIndex !== null && (await toPage(target.pageIndex, [])));
      }
    },
  };
}

/** Waits until the page list has laid out its pages (it has none on the first frame). */
function whenLaidOut(api: RefObject<PageListApi | null>): Promise<boolean> {
  return new Promise((resolve) => {
    const until = performance.now() + 5000;
    const look = () => {
      if ((api.current?.pageBoxes().length ?? 0) > 0) resolve(true);
      else if (performance.now() > until) resolve(false);
      else requestAnimationFrame(look);
    };
    look();
  });
}

/**
 * What the address of a saved copy asked for, shown once the PDF is open: the note (`note`), or the words on the page
 * (`q` with `#page=N`). `settled` is the notes' "have had their chance to load" (NotesHost.notesSettled); null until the
 * notes exist. `say` tells the reader when the note is gone. Runs once per document.
 */
export function useOpenTarget(o: {
  params: Pick<ViewerParams, 'note' | 'q' | 'page'>;
  jumper: HitJumper;
  api: RefObject<PageListApi | null>;
  settled: (() => Promise<void>) | null;
  say(this: void, text: string): void;
}): void {
  const { params, jumper, api, settled, say } = o;
  const done = useRef(false);
  const note = params.note ?? null;
  const q = params.q ?? null;
  const page = params.page;
  useEffect(() => {
    if (done.current) return;
    if (note === null && (q === null || page === null)) {
      done.current = true;
      return;
    }
    if (note !== null && settled === null) return; // the notes mount a moment after the PDF: try again then
    done.current = true;
    void (async () => {
      if (!(await whenLaidOut(api))) return;
      if (note !== null) {
        await settled?.();
        if (!(await jumper.toNote(note as ThreadId, { history: false }))) say('Couldn’t find that note. It may have been deleted.');
        return;
      }
      if (q !== null && page !== null) await jumper.toPage(page - 1, queryTerms(q), { history: false });
    })();
  }, [note, q, page, jumper, api, settled, say]);
}
