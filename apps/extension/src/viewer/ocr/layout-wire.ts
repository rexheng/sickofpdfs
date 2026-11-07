// Figures on scanned pages (Phase 7.4): the viewer tab's side. A page that needs recognition (needsOcr: it is a picture of a page)
// has no objects to find figures in, so the layout model looks at the page picture instead (ocr/layout). The figure service asks
// this for every page; a page with its own text gets null and is found from its objects as always.
//
// Privacy: the page is drawn small in this tab, read by a worker that has no network, and only the boxes come back. They are kept
// in memory for this tab's life and never stored, posted or logged, whether the PDF is saved or not (the recognised words that name
// a caption are the page's own text, read from what the tab already holds).
import { type DetectedFigure, needsOcr } from '@sop/core';
import type { PdfBackend } from '@sop/viewer';
import { createLayoutDetector, type LayoutDetector } from '../../ocr/layout/layout-model';
import { LAYOUT_RENDER_DPI, type LayoutBox } from '../../ocr/layout/models';
import { toFigures } from '../../ocr/layout/to-figures';
import { createPageSource } from '../../ocr/page-source';
import type { OpenedDocument } from '../open-document';
import type { ViewerOcr } from './wire';

export interface ScanFigures {
  /** The page's figures now (named from its recognised words if they are known), or null when it is not a scan. */
  figures(pageIndex: number): Promise<DetectedFigure[] | null>;
  /** `cb(pageIndex)` when a scan's words arrive after its figures were found: the figures are then named again. */
  onNamed(cb: (pageIndex: number) => void): () => void;
  dispose(): void;
}

export function createScanFigures(d: { backend: PdfBackend; opened: OpenedDocument; ocr: ViewerOcr }): ScanFigures {
  const pages = d.opened.open.pages;
  const source = createPageSource(d.backend, d.opened.open.doc, pages);
  let detector: LayoutDetector | null = null;
  let disposed = false;
  const kinds = new Map<number, Promise<boolean>>();

  const isScan = (i: number): Promise<boolean> => {
    let k = kinds.get(i);
    if (!k) {
      k = source.pageKind(i).then(needsOcr, () => false);
      kinds.set(i, k);
    }
    return k;
  };

  /** A page's boxes are found once (the page picture is drawn and read once) and kept in memory. */
  const layouts = new Map<number, Promise<{ boxes: LayoutBox[]; width: number; height: number }>>();
  const layoutOf = (i: number) => {
    let l = layouts.get(i);
    if (!l) {
      l = source.renderForOcr(i, LAYOUT_RENDER_DPI).then(async (image) => {
        const size = { width: image.width, height: image.height };
        detector ??= createLayoutDetector({ base: chrome.runtime.getURL('') });
        return { boxes: await detector.detect(image), ...size };
      });
      l.catch(() => layouts.delete(i)); // a failure is not remembered: the page may be asked again
      layouts.set(i, l);
    }
    return l;
  };
  const named = new Set<number>();
  const listeners = new Set<(i: number) => void>();
  const off = d.ocr.onPageText((i) => {
    if (named.delete(i)) for (const cb of [...listeners]) cb(i);
  });

  return {
    async figures(i) {
      if (disposed || !pages[i] || !(await isScan(i))) return null;
      const { boxes, width, height } = await layoutOf(i);
      const ocr = d.ocr.lookup.known(i);
      // The outline never waits for the words: a page read later is named then (onNamed).
      if (ocr === null && d.ocr.reading()) named.add(i);
      const dpi = (Math.max(width, height) / Math.max(pages[i].width, pages[i].height)) * 72;
      return toFigures(boxes, { width, height }, pages[i], dpi, ocr === null ? null : { words: ocr.words, text: ocr.text });
    },
    onNamed(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      disposed = true;
      off();
      listeners.clear();
      detector?.dispose();
      detector = null;
    },
  };
}
