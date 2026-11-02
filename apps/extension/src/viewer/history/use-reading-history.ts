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
import { openingSpot, readerSpot, resumeReading } from './resume';

/** The quiet note after a resume. */
export const RESUMED_NOTE = (page: number): string => `Opened on page ${page}, where you stopped.`;
export const START_OVER_LABEL = 'Start from page 1';

export function useReadingHistory(o: {
  doc: OpenedDocument;
  params: ViewerParams;
  view: ViewerStore;
  pageList: RefObject<PageListApi | null>;
  save: SaveControllerImpl | null;
  ui: ViewerUi;
  /** The document was opened again after the engine stopped, at the reader's own place: that place is kept, not the library's. */
  restarted: boolean;
}): void {
  const { doc, params, view, pageList, save, ui, restarted } = o;
  useEffect(() => {
    const api = pageList.current;
    if (save === null || api === null || isIncognito()) return;
    const opening = openingSpot(view, api);
    // The first time the PDF turns out to be saved is the open: a spot is only ever resumed then.
    let first = !restarted;
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
        if (resumed === null) return;
        ui.showNote(RESUMED_NOTE(resumed.page + 1), { label: START_OVER_LABEL, run: () => void resumed.startOver() });
      },
    });
    return () => tracker.dispose();
  }, [doc, params, view, pageList, save, ui, restarted]);
}
