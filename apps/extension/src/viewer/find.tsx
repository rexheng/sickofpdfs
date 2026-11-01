// Find in the open document (Ctrl+F, Task 25), for the Reader in App.tsx: the find bar, its highlights on the pages,
// moving to a hit, and Alt+Enter's selection. The search itself is @sop/viewer's createFindController, made on the
// first Ctrl+F (ViewerContext.find).
//
// Moving to a hit: a hit already in view stays where it is; otherwise the view scrolls to put it in the middle, through
// the jump history when the viewer has one (Task 24), so Back returns to where the reader was before the search.
import {
  type CharRange,
  contentPointToPage,
  createFindController,
  type FindController,
  type JumpHistory,
  type PageBox,
  type PageSize,
  type PageTextProviderImpl,
  pagePointToContent,
  type PdfBackend,
  type PdfRect,
  type ScanDetector,
  type SearchHit,
  selectCharRanges,
  type ViewerStore,
  viewPosition,
} from '@sop/viewer';
import { FindBar, FindHighlights, type PageLayerContext, type PageListApi, type TextLayerController } from '@sop/viewer/react';
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Snackbar } from './chrome/Snackbar';
import type { OpenedDocument } from './open-document';

/** After Esc, the hit the bar was on stays drawn as a selection this long (find-highlights.css fades it). */
const LINGER_MS = 1200;
/** Alt+Enter waits at most this long for the hit's page to get its text layer. */
const SELECT_WAIT_MS = 5000;

export interface ReaderFind {
  /** For ViewerContext.find: null until the first Ctrl+F. */
  controller: FindController | null;
  /** Ctrl+F: opens the bar, or puts the focus back in it with its words selected. */
  open(this: void): void;
  /** The bar and its notes. Mount once in the Reader. */
  view: ReactNode;
  /** For PageList's renderPage: the page's find highlights (nothing until the first search). */
  pageLayer(this: void, box: PageBox, ctx: PageLayerContext): ReactNode;
}

interface FindDeps {
  backend: PdfBackend;
  doc: OpenedDocument;
  store: ViewerStore;
  api: RefObject<PageListApi | null>;
  /** The tab's page text: the rects selections and marks are drawn with. */
  pageText: PageTextProviderImpl;
  textLayers: TextLayerController;
  /** The jump history (Task 24); null before it exists, and the view then just scrolls. */
  jumps: JumpHistory | null;
  root: RefObject<HTMLElement | null>;
  /** The scan check: when the document is a scan, the bar says so as it opens (not after searching every page). */
  scans: ScanDetector;
}

/** The union of rects. */
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

/**
 * A hit this close to the top of the view (CSS px) counts as out of view: the find bar lies over the top right of the
 * pages. One this close to the bottom or a side is too near the edge to be seen at a glance.
 */
const CLEAR_TOP_PX = 72;
const CLEAR_EDGE_PX = 32;

/** The scroll position that shows a hit, or null when it is in view already. */
function scrollFor(scroller: HTMLElement, box: PageBox, page: PageSize, r: PdfRect): { left: number; top: number } | null {
  const a = pagePointToContent(box, page, { x: r.x, y: r.y });
  const b = pagePointToContent(box, page, { x: r.x + r.width, y: r.y + r.height });
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const { scrollLeft, scrollTop, clientWidth, clientHeight } = scroller;
  const inX = x0 >= scrollLeft + CLEAR_EDGE_PX && x1 <= scrollLeft + clientWidth - CLEAR_EDGE_PX;
  const inY = y0 >= scrollTop + CLEAR_TOP_PX && y1 <= scrollTop + clientHeight - CLEAR_EDGE_PX;
  if (inX && inY) return null;
  return {
    left: inX ? scrollLeft : Math.round((x0 + x1) / 2 - clientWidth / 2),
    top: inY ? scrollTop : Math.round((y0 + y1) / 2 - clientHeight / 2),
  };
}

/** The find bar, its highlights and its moves, for one open document. */
export function useReaderFind({ backend, doc, store, api, pageText, textLayers, jumps, root, scans }: FindDeps): ReaderFind {
  const pages = doc.open.pages;
  const [controller, setController] = useState<FindController | null>(null);
  const made = useRef<FindController | null>(null);
  const [open, setOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [linger, setLinger] = useState<SearchHit | null>(null);
  const [note, setNote] = useState<{ text: string } | null>(null);
  const lastQuery = useRef('');
  const jumpsRef = useRef(jumps);
  useEffect(() => {
    jumpsRef.current = jumps;
  }, [jumps]);

  useEffect(
    () => () => {
      made.current?.dispose();
      made.current = null;
    },
    [],
  );
  useEffect(() => {
    if (linger === null) return;
    const timer = setTimeout(() => setLinger(null), LINGER_MS);
    return () => clearTimeout(timer);
  }, [linger]);

  // Is this document a scan? Asked when the bar opens: the page in view (the scan hint has usually asked already, so
  // for a PDF with text this costs no engine call), then, only if that page is a scan, the first and the last page.
  // All three pictures with no text: the bar says so at once.
  const [scanned, setScanned] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const others = [...new Set([0, doc.open.pageCount - 1])];
    scans
      .isScannedPage(store.get().currentPage)
      .then(async (scan) => scan && (await Promise.all(others.map((i) => scans.isScannedPage(i)))).every(Boolean))
      .then(
        (scan) => live && setScanned(scan),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [open, scans, store, doc]);

  const scroller = useCallback(() => root.current?.querySelector<HTMLElement>('[role="document"]') ?? null, [root]);

  /** Brings a hit into view (through the jump history), unless it is in view already. Only the latest call moves the view. */
  const revealSeq = useRef(0);
  const reveal = useCallback(
    async (hit: SearchHit): Promise<void> => {
      const seq = ++revealSeq.current;
      // PDFium's own rects for the range: enough to place the view, and they need no glyphs (one quick engine call).
      const rects = await pageText.rects(hit.pageIndex, hit.start, hit.count).catch((): PdfRect[] => []);
      if (seq !== revealSeq.current) return;
      const list = api.current;
      const el = scroller();
      const box = list?.pageBoxes()[hit.pageIndex];
      const page = pages[hit.pageIndex];
      if (!list || !el || !box || !page) return;
      const r = bounds(rects) ?? { x: 0, y: 0, width: page.width, height: 0 };
      const to = scrollFor(el, box, page, r);
      if (to === null) return;
      const history = jumpsRef.current;
      if (history === null) {
        el.scrollTo({ left: to.left, top: to.top, behavior: 'instant' });
        return;
      }
      // The jump's destination is the point that goes to the top-left corner of the view.
      const p = contentPointToPage(box, page, { x: to.left, y: to.top });
      history.jumpTo({ kind: 'page', pageIndex: hit.pageIndex, top: p.y, left: p.x }, viewPosition(list, store.get().scale));
    },
    [api, pageText, pages, scroller, store],
  );

  const close = useCallback(
    (o: { keep: boolean }) => {
      const c = made.current;
      if (c !== null) {
        const s = c.state;
        lastQuery.current = s.query;
        if (o.keep && s.current >= 0) setLinger(s.hits[s.current] ?? null);
        c.setQuery('');
      }
      // The bar goes, and the focus with it (to the page itself), so the reading keys move the pages again.
      setOpen(false);
    },
    [],
  );

  const openBar = useCallback(() => {
    if (made.current === null) {
      made.current = createFindController(backend, doc.open.doc, doc.open.pageCount, () => store.get().currentPage);
      setController(made.current);
    }
    setLinger(null);
    setOpen(true);
    setFocusRequest((n) => n + 1);
  }, [backend, doc, store]);

  const selectMatch = useCallback(
    (hit: SearchHit) => {
      close({ keep: false });
      void (async () => {
        await reveal(hit);
        await Promise.race([textLayers.whenReady(hit.pageIndex), new Promise((resolve) => setTimeout(resolve, SELECT_WAIT_MS))]);
        const where = root.current;
        if (where === null) return;
        const range: CharRange = { pageIndex: hit.pageIndex, start: hit.start, end: hit.start + hit.count };
        selectCharRanges(where, [range]);
      })();
    },
    [close, reveal, textLayers, root],
  );

  const onJump = useCallback((hit: SearchHit) => void reveal(hit), [reveal]);
  const onClose = useCallback(() => close({ keep: true }), [close]);
  const onWrap = useCallback((to: 'first' | 'last') => setNote({ text: to === 'first' ? 'Back to the first match' : 'Back to the last match' }), []);

  const pageLayer = useCallback(
    (box: PageBox, ctx: PageLayerContext): ReactNode =>
      controller === null ? null : <FindHighlights controller={controller} text={pageText} box={box} ctx={ctx} page={pages[box.index]} linger={linger} />,
    [controller, pageText, pages, linger],
  );

  const view = (
    <>
      {open && controller !== null && (
        <FindBar
          controller={controller}
          initialQuery={lastQuery.current}
          focusRequest={focusRequest}
          onJump={onJump}
          onSelectMatch={selectMatch}
          onClose={onClose}
          onWrap={onWrap}
          scanned={scanned}
        />
      )}
      <Snackbar note={note} />
    </>
  );

  return { controller, open: openBar, view, pageLayer };
}
