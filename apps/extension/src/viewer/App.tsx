// The viewer page: opens the PDF the address names, then shows its pages. One engine and one render queue per tab.
import '@sop/ui/tokens.css';
import '@sop/ui/base.css';
import { registerFonts } from '@sop/ui';
import {
  createEmbedPdfBackend,
  createViewerStore,
  displayNameFor,
  ENGINE_WORKERS,
  engineAssets,
  PdfLoadError,
  RenderScheduler,
  ScanDetector,
  useViewerState,
  type ViewerStore,
} from '@sop/viewer';
import { PageList, type PageListApi } from '@sop/viewer/react';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseViewerUrl } from '../shared/viewer-url';
import styles from './App.module.css';
import { type LargeFileBounce, type OpenDocumentDeps, type OpenedDocument, openDocument, type OpenOutcome, openPickedFile } from './open-document';
import { publishRuntime, type ViewerHooks, type ViewerState } from './runtime';
import { installShortcuts, type ShortcutDef } from './shortcuts';
import { openFileSettings, openInChromeViewer } from './takeover-client';
import { FileAccessDialog } from './ui/FileAccessDialog';
import { LargeFileNotice } from './ui/LargeFileNotice';
import { LoadErrorCard } from './ui/LoadErrorCard';
import { PasswordDialog } from './ui/PasswordDialog';
import { ScanHint } from './ui/ScanHint';

/** The tab's one engine. Its worker starts at once, so PDFium is ready by the time the PDF has downloaded. */
const backend = createEmbedPdfBackend(engineAssets((p) => chrome.runtime.getURL(p)), { workers: ENGINE_WORKERS, startNow: true });

type View = { kind: 'loading' } | Exclude<OpenOutcome, { kind: 'ready' }> | { kind: 'ready'; doc: OpenedDocument };

let currentView: View = { kind: 'loading' };
publishRuntime({
  backend,
  doc: () => (currentView.kind === 'ready' ? currentView.doc : null),
  viewerState: (): ViewerState => currentView.kind,
});

interface PasswordPrompt {
  retry: boolean;
  attempt: number;
  resolve: (password: string | null) => void;
}

export function App() {
  const params = useMemo(() => parseViewerUrl(location.href), []);
  const [view, setView] = useState<View>(currentView);
  const [prompt, setPrompt] = useState<PasswordPrompt | null>(null);
  const [bounce, setBounce] = useState<LargeFileBounce | null>(null);
  const [fileDialogOpen, setFileDialogOpen] = useState(true);
  const attempts = useRef(0);
  const started = useRef(false);

  const show = useCallback((next: View) => {
    currentView = next;
    setView(next);
  }, []);

  const deps = useMemo<OpenDocumentDeps>(
    () => ({
      backend,
      askPassword: (retry) =>
        new Promise((resolve) => {
          attempts.current += 1;
          setPrompt({
            retry,
            attempt: attempts.current,
            resolve: (password) => {
              setPrompt(null);
              resolve(password);
            },
          });
        }),
      onLargeFile: setBounce,
    }),
    [],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void registerFonts().catch(() => {}); // text falls back to the next font until the files load
    void openDocument(params, deps).then(show);
  }, [params, deps, show]);

  useEffect(() => {
    document.title = view.kind === 'ready' ? view.doc.loaded.displayName : displayNameFor(params.source, null);
  }, [view, params]);

  const importFile = useCallback(
    (file: File) => {
      setFileDialogOpen(false);
      show({ kind: 'loading' });
      void openPickedFile(file, deps).then(show);
    },
    [deps, show],
  );

  const openInChrome = useCallback((url: string) => void openInChromeViewer(url), []);
  const fileAccess = view.kind === 'error' && view.error instanceof PdfLoadError && view.error.code === 'file-access';

  return (
    <div className={styles.app}>
      {view.kind === 'ready' && <Reader doc={view.doc} initialPage={params.page} onOpenInChrome={openInChrome} />}
      {view.kind === 'loading' && prompt === null && <div role="progressbar" aria-label="Loading the PDF" className={styles.progress} />}
      {view.kind === 'error' && !(fileAccess && fileDialogOpen) && (
        <LoadErrorCard error={view.error} sourceUrl={params.source} onOpenInChrome={openInChrome} onImport={importFile} />
      )}
      {fileAccess && (
        <FileAccessDialog
          open={fileDialogOpen}
          onOpenChange={setFileDialogOpen}
          onOpenSettings={() => void openFileSettings()}
          onChooseFile={importFile}
        />
      )}
      {view.kind === 'bounced' && bounce !== null && <LargeFileNotice size={bounce.size} onOpenNow={bounce.openNow} />}
      {prompt !== null && <PasswordDialog retry={prompt.retry} attempt={prompt.attempt} onSubmit={prompt.resolve} />}
    </div>
  );
}

/** The open document: the page list, its keys, the scan hint, and its test hooks. */
function Reader({ doc, initialPage, onOpenInChrome }: { doc: OpenedDocument; initialPage: number | null; onOpenInChrome: (url: string) => void }) {
  const [store] = useState(() =>
    createViewerStore({ currentPage: Math.min(doc.open.pageCount - 1, Math.max(0, (initialPage ?? 1) - 1)) }),
  );
  const [scheduler] = useState(
    () => new RenderScheduler(backend, doc.open.doc, { concurrency: ENGINE_WORKERS, previewWidthPx: 160, previewCache: 300 }),
  );
  const [scans] = useState(() => new ScanDetector(backend, doc.open.doc, doc.open.pages));
  const api = useRef<PageListApi | null>(null);
  useEffect(() => installShortcuts(readerShortcuts(api)), []);
  useEffect(() => publishRuntime({ viewer: viewerHooks(api, store, scans) }), [store, scans]);
  return (
    <>
      <PageList backend={backend} doc={doc} store={store} scheduler={scheduler} apiRef={api} />
      <CurrentPageExtras store={store} scans={scans} source={doc.loaded.sourceUrl} onOpenInChrome={onOpenInChrome} />
    </>
  );
}

/** What follows the page in view: `#page=N` in the address, and the scan hint. Kept apart so the page list does not re-render. */
function CurrentPageExtras(p: { store: ViewerStore; scans: ScanDetector; source: string | null; onOpenInChrome: (url: string) => void }) {
  const currentPage = useViewerState(p.store, (s) => s.currentPage);
  const scanned = useScannedPage(p.scans, currentPage);
  usePageHash(currentPage);
  const { source, onOpenInChrome } = p;
  return scanned && source !== null ? <ScanHint onOpenInChrome={() => onOpenInChrome(source)} /> : null;
}

/** How long the reader stays on a page before it is checked for being a scan (the check shares the engine). */
const SCAN_CHECK_DELAY_MS = 400;

/** Whether page `index` is a scan, checked once the reader has stayed on it for a moment. */
function useScannedPage(scans: ScanDetector, index: number): boolean {
  const [scanned, setScanned] = useState<{ index: number; scan: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      scans.isScannedPage(index).then(
        (scan) => live && setScanned({ index, scan }),
        () => {},
      );
    }, SCAN_CHECK_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [scans, index]);
  return scanned !== null && scanned.index === index && scanned.scan;
}

/** How long the page number waits before it is written to the address (#page=N), so a fast scroll writes once. */
const PAGE_HASH_DELAY_MS = 300;

/** Keeps `#page=N` in the address in step with the page in view, with history.replaceState (never a navigation). */
function usePageHash(index: number): void {
  useEffect(() => {
    const timer = setTimeout(() => {
      const url = new URL(location.href);
      const hash = `#page=${index + 1}`;
      if (url.hash === hash || (url.hash === '' && index === 0)) return;
      url.hash = hash;
      history.replaceState(history.state, '', url);
    }, PAGE_HASH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [index]);
}

/** Keys aimed at the pages: only when nothing else (a menu, a dialog, a field) has the focus. */
function inPageArea(): boolean {
  const a = document.activeElement;
  return a === null || a === document.body || a === document.documentElement || a.closest('[role="document"]') !== null;
}

/** Zoom keys (Chrome's: the browser zoom never changes) and Chromium's viewer scroll keys. */
function readerShortcuts(api: RefObject<PageListApi | null>): ShortcutDef[] {
  const on = (f: (a: PageListApi) => void) => () => {
    if (api.current) f(api.current);
  };
  const page = (id: string, keys: string[], f: (a: PageListApi) => void): ShortcutDef => ({ id, keys, run: on(f), enabled: inPageArea });
  return [
    { id: 'view.zoomIn', keys: ['Ctrl+=', 'Ctrl++'], run: on((a) => a.zoomStep(1)) },
    { id: 'view.zoomOut', keys: ['Ctrl+-', 'Ctrl+_'], run: on((a) => a.zoomStep(-1)) },
    { id: 'view.fitWidth', keys: ['Ctrl+0'], run: on((a) => a.zoomTo({ kind: 'fit-width' })) },
    page('scroll.lineDown', ['ArrowDown'], (a) => a.scrollLines(1)),
    page('scroll.lineUp', ['ArrowUp'], (a) => a.scrollLines(-1)),
    page('scroll.screenDown', ['PageDown', 'Space'], (a) => a.scrollScreens(1)),
    page('scroll.screenUp', ['PageUp', 'Shift+Space'], (a) => a.scrollScreens(-1)),
    page('scroll.start', ['Home'], (a) => a.goToStart()),
    page('scroll.end', ['End'], (a) => a.goToEnd()),
    page('scroll.left', ['ArrowLeft'], (a) => a.scrollSideways(-1)),
    page('scroll.right', ['ArrowRight'], (a) => a.scrollSideways(1)),
  ];
}

/** How long viewer.scrollTo waits for the page's full render before giving up. */
const SCROLL_TO_TIMEOUT_MS = 10_000;

function viewerHooks(api: RefObject<PageListApi | null>, store: ViewerStore, scans: ScanDetector): ViewerHooks {
  const a = () => api.current;
  return {
    scale: () => store.get().scale,
    setScale: (s) => a()?.zoomTo({ kind: 'scale', scale: s }),
    currentPage: () => store.get().currentPage,
    scrollTo: (i) =>
      Promise.race([a()?.goToPage(i) ?? Promise.resolve(), new Promise<void>((resolve) => setTimeout(resolve, SCROLL_TO_TIMEOUT_MS))]),
    snapshot: () => ({ ...store.get() }),
    scrollTop: () => a()?.scrollTop() ?? 0,
    maxScrollTop: () => a()?.maxScrollTop() ?? 0,
    viewportHeight: () => a()?.viewportHeight() ?? 0,
    pageBoxes: () => a()?.pageBoxes() ?? [],
    pdfPointAt: (x, y) => a()?.pdfPointAt(x, y) ?? null,
    clientPointOf: (p) => a()?.clientPointOf(p) ?? { x: NaN, y: NaN },
    isScannedPage: (i) => scans.isScannedPage(i),
  };
}
