// Moving around a document (Task 24), for the Reader in App.tsx: links inside its pages, the jump history that Back
// undoes, the outline, and where the navigation rail starts.
import {
  createJumpHistory,
  createPageLinkSource,
  goToTarget,
  type JumpHistory,
  type LinkTarget,
  type OutlineItem,
  type PageBox,
  type PdfBackend,
  resolveLinkUri,
  restorePosition,
  viewPosition,
  type ViewerStore,
  type ViewPosition,
} from '@sop/viewer';
import { type PageListApi, PageLinks } from '@sop/viewer/react';
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OpenedDocument } from './open-document';
import { installShortcuts } from './shortcuts';

/** Below this window width the rail starts closed, and when opened it lies over the pages (NavRail.module.css). */
export const RAIL_OVERLAY_BELOW_PX = 1100;

const narrowWindow = () => window.matchMedia(`(width < ${RAIL_OVERLAY_BELOW_PX}px)`);

/** Whether the rail starts open: in a window 1100 px wide or more. */
export function railStartsOpen(): boolean {
  return !narrowWindow().matches;
}

/**
 * The rail folds away when the window narrows below 1100 px, and comes back when it widens again if it was folded
 * away that way (spec: at narrow widths "the thumbnail rail collapses first").
 */
export function useRailFitsWindow(store: ViewerStore): void {
  useEffect(() => {
    const q = narrowWindow();
    let folded = false;
    const onChange = () => {
      if (q.matches && store.get().railOpen) {
        folded = true;
        store.set({ railOpen: false });
      } else if (!q.matches && folded) {
        folded = false;
        store.set({ railOpen: true });
      }
    };
    q.addEventListener('change', onChange);
    return () => q.removeEventListener('change', onChange);
  }, [store]);
}

/** The document's outline, read once; null until then, [] when it has none (or it could not be read). */
export function useOutline(backend: Pick<PdfBackend, 'getOutline'>, doc: OpenedDocument): OutlineItem[] | null {
  const [outline, setOutline] = useState<{ doc: OpenedDocument; items: OutlineItem[] } | null>(null);
  useEffect(() => {
    let live = true;
    backend.getOutline(doc.open.doc).then(
      (items) => live && setOutline({ doc, items }),
      () => live && setOutline({ doc, items: [] }),
    );
    return () => {
      live = false;
    };
  }, [backend, doc]);
  return outline !== null && outline.doc === doc ? outline.items : null;
}

export interface ReaderNavigation {
  /** For ViewerContext.jumps: links (and find, Task 25) jump through it, so Back returns. */
  jumps: JumpHistory;
  /** PageList's renderPage: each page's links. */
  renderPage(this: void, box: PageBox): ReactNode;
  /** A thumbnail: that page, from its top. Not in history. */
  onPage(this: void, index: number): void;
  /**
   * An outline item: its destination, as a link would go there, and through the same jump history, so Back returns to
   * where the reader was (TB4 ruling; a thumbnail press still adds nothing).
   */
  onOutline(this: void, t: LinkTarget): void;
}

interface NavigationDeps {
  backend: Pick<PdfBackend, 'getLinks'>;
  doc: OpenedDocument;
  store: ViewerStore;
  api: RefObject<PageListApi | null>;
}

/**
 * The Reader's links, jumps and rail callbacks. The jump history listens to Back while the document is open; Back
 * puts the zoom and the scroll position back exactly.
 */
export function useReaderNavigation({ backend, doc, store, api }: NavigationDeps): ReaderNavigation {
  const pages = doc.open.pages;
  const live = useRef<JumpHistory | null>(null);
  useEffect(() => {
    const restore = (p: ViewPosition) => {
      if (api.current) void restorePosition(api.current, store.get().scale, p);
    };
    const go = (t: LinkTarget & { kind: 'page' }) => {
      if (api.current) void goToTarget(api.current, pages, t);
    };
    const h = createJumpHistory(window, restore, go);
    live.current = h;
    return () => {
      h.dispose();
      live.current = null;
    };
  }, [api, store, pages]);
  // Alt+Left and Alt+Right are Chrome's own Back and Forward keys. The viewer runs them itself (and Chrome then leaves
  // them), so they work the same wherever the focus is in the page, and in tests that cannot press browser keys.
  useEffect(
    () =>
      installShortcuts([
        { id: 'history.back', keys: ['Alt+ArrowLeft'], run: () => window.history.back() },
        { id: 'history.forward', keys: ['Alt+ArrowRight'], run: () => window.history.forward() },
      ]),
    [],
  );
  // What the commands and the links hold: the history of the moment (the Reader disposes the real one).
  const jumps = useMemo<JumpHistory>(() => ({ jumpTo: (t, from) => live.current?.jumpTo(t, from), dispose: () => {} }), []);

  const [links] = useState(() => createPageLinkSource(backend, doc.open.doc, doc.loaded.sourceUrl));
  const followLink = useCallback(
    (t: LinkTarget & { kind: 'page' }) => {
      if (api.current) jumps.jumpTo(t, viewPosition(api.current, store.get().scale));
    },
    [api, jumps, store],
  );
  const renderPage = useCallback(
    (box: PageBox) => <PageLinks source={links} box={box} page={pages[box.index]} onInternal={followLink} />,
    [links, pages, followLink],
  );
  const onPage = useCallback((index: number) => void api.current?.goToPage(index), [api]);
  const source = doc.loaded.sourceUrl;
  const onOutline = useCallback(
    (t: LinkTarget) => {
      if (t.kind === 'page') {
        followLink(t);
        return;
      }
      // A web address in the outline opens in this tab, as Chrome's viewer does; any other scheme does nothing.
      const href = resolveLinkUri(t.url, source);
      if (href !== null) location.assign(href);
    },
    [followLink, source],
  );
  return useMemo(() => ({ jumps, renderPage, onPage, onOutline }), [jumps, renderPage, onPage, onOutline]);
}
