// Mounts the reading history for the open PDF (S16): the tracker (reading-tracker.ts) and the resume (resume.ts). Made when
// the page list and the save controller exist, ended with the document. Never made in Incognito, where nothing is kept.
import type { ViewerStore, ViewPosition } from '@sop/viewer';
import type { PageListApi } from '@sop/viewer/react';
import { type RefObject, useEffect } from 'react';
import type { ViewerParams } from '../../shared/viewer-url';
import { libraryStore } from '../use-store';
import type { ViewerUi } from '../commands';
import { isIncognito } from '../incognito';
import type { OpenedDocument } from '../open-document';
import type { SaveControllerImpl } from '../save/save-controller';
import { createReadingTracker } from './reading-tracker';
import { openingSpot, readerHasMoved, readerSpot, resumeReading } from './resume';
import { shownPage } from '../page-order/shown';

/** The quiet note after a resume. */
export const RESUMED_NOTE = (page: number): string => `Opened on page ${page}, where you stopped.`;
export const START_OVER_LABEL = 'Start from page 1';

/** "Start from page 1", while it is on offer (the note, and File → Start from page 1). */
export interface StartOverOffer {
  run(this: void): void;
}

/** Keys that only move the focus or are held with another: they do not count as the reader moving on. */
const NOT_A_MOVE = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** The next two frames: the page box has followed the scroll by then. */
const twoFrames = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/**
 * TB5: the resume note stays until the reader scrolls (by any means: wheel, keys, the scrollbar, a page change, a zoom) or
 * presses a key, rather than for a few seconds, so a keyboard reader can reach it. Tab (to reach its button) does not
 * count, and neither do keys pressed on the note itself.
 */
function untilReaderMoves(view: ViewerStore, pageList: RefObject<PageListApi | null>, done: () => void): () => void {
  const api = pageList.current;
  if (api === null) return () => {};
  const here = openingSpot(view, api);
  const check = (): void => {
    const now = pageList.current;
    if (now === null || readerHasMoved(here, view, now)) done();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (NOT_A_MOVE.has(e.key)) return;
    if (e.target instanceof Element && e.target.closest('[role="status"]') !== null) return;
    done();
  };
  const stopView = view.subscribe(check);
  document.addEventListener('scroll', check, { capture: true, passive: true });
  document.addEventListener('wheel', done, { capture: true, passive: true });
  document.addEventListener('touchmove', done, { capture: true, passive: true });
  document.addEventListener('keydown', onKey, { capture: true });
  return () => {
    stopView();
    document.removeEventListener('scroll', check, { capture: true });
    document.removeEventListener('wheel', done, { capture: true });
    document.removeEventListener('touchmove', done, { capture: true });
    document.removeEventListener('keydown', onKey, { capture: true });
  };
}

export function useReadingHistory(o: {
  doc: OpenedDocument;
  params: ViewerParams;
  view: ViewerStore;
  pageList: RefObject<PageListApi | null>;
  save: SaveControllerImpl | null;
  ui: ViewerUi;
  /** The document was opened again after the engine stopped, at the reader's own place: that place is kept, not the library's. */
  restarted: boolean;
  /** "Start from page 1" is on offer (File menu), or no longer is once it was used. */
  onStartOver(this: void, offer: StartOverOffer | null): void;
}): void {
  const { doc, params, view, pageList, save, ui, restarted, onStartOver } = o;
  useEffect(() => {
    const api = pageList.current;
    if (save === null || api === null || isIncognito()) return;
    const opening = openingSpot(view, api);
    // The first time the PDF turns out to be saved is the open: a spot is only ever resumed then.
    let first = !restarted;
    let live = true;
    const tracker = createReadingTracker({
      save,
      store: libraryStore,
      view,
      position(): ViewPosition | null {
        const list = pageList.current;
        // Presenting shows one page a screen at another scale: the last normal position stands.
        return list === null || view.get().presenting !== null ? null : readerSpot(list, view.get().scale, doc.open.pageCount);
      },
      async atSaved(reading) {
        if (!first) return;
        first = false;
        const resumed = await resumeReading({ link: params, reading, pageCount: doc.open.pageCount, opening, view, pageList: () => pageList.current });
        if (resumed === null || !live) return;
        // The note names the page the page box shows (TB5), not the page under the top edge of the view.
        await twoFrames();
        if (!live) return;
        let offered = true;
        const run = (): void => {
          if (!offered) return;
          offered = false;
          onStartOver(null);
          void resumed.startOver();
        };
        onStartOver({ run });
        ui.showNote(RESUMED_NOTE(shownPage(view.get().currentPage)), { label: START_OVER_LABEL, run, until: (done) => untilReaderMoves(view, pageList, done) });
      },
    });
    return () => {
      live = false;
      tracker.dispose();
      onStartOver(null);
    };
  }, [doc, params, view, pageList, save, ui, restarted, onStartOver]);
}
