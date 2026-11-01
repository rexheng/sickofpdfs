// The viewer page: opens the PDF the address names, then shows its pages. One engine and one render queue per tab.
// It also owns the takeover's viewer side (Task 17): leaving a frame for the full tab, "Back to page" for an embedded
// PDF, and the escape hatch to Chrome's own viewer.
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
import { sendRuntimeMessage } from '../shared/send-message';
import { parseViewerUrl } from '../shared/viewer-url';
import styles from './App.module.css';
import { backTarget, goBackToPage } from './back-to-page';
import { maybeLeaveFrame, wantsFullTab } from './frame-escape';
import { type LargeFileBounce, type OpenDocumentDeps, type OpenedDocument, openDocument, type OpenOutcome, openPickedFile } from './open-document';
import { publishRuntime, type ViewerHooks, type ViewerState } from './runtime';
import { openInChrome } from './open-in-chrome';
import { installShortcuts, type ShortcutDef } from './shortcuts';
import { FileAccessDialog } from './ui/FileAccessDialog';
import { LargeFileNotice } from './ui/LargeFileNotice';
import { LoadErrorCard } from './ui/LoadErrorCard';
import { PasswordDialog } from './ui/PasswordDialog';
import { ScanHint } from './ui/ScanHint';
import { ViewerBar } from './ui/ViewerBar';

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
  // In a frame of some page, the PDF opens in the whole tab instead; until the worker says otherwise, nothing loads here.
  const [leaving, setLeaving] = useState(() => wantsFullTab(params));
  const [chromeRefused, setChromeRefused] = useState(false);
  const attempts = useRef(0);
  const started = useRef(false);
  const loading = useRef(false);

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
    // Embedded in a page: ask for the full tab. If this page's PDFs are suppressed (the person came back), stay here.
    maybeLeaveFrame(params, () => setLeaving(false));
  }, [params]);

  useEffect(() => {
    if (leaving || loading.current) return;
    loading.current = true;
    void openDocument(params, deps).then(show);
  }, [leaving, params, deps, show]);

  useEffect(() => {
    if (leaving) document.title = 'sickofpdfs';
    else document.title = view.kind === 'ready' ? view.doc.loaded.displayName : displayNameFor(params.source, null);
  }, [leaving, view, params]);

  const importFile = useCallback(
    (file: File) => {
      setFileDialogOpen(false);
      show({ kind: 'loading' });
      void openPickedFile(file, deps).then(show);
    },
    [deps, show],
  );

  /** The escape hatch: this address in Chrome's own viewer, once. Chrome refuses a local file without file access. */
  const escape = useCallback((url: string) => {
    setChromeRefused(false);
    void openInChrome(url).then((ok) => setChromeRefused(!ok));
  }, []);
  const fileAccess = view.kind === 'error' && view.error instanceof PdfLoadError && view.error.code === 'file-access';
  const back = backTarget(params);
  const source = params.source;
  const name = view.kind === 'ready' ? view.doc.loaded.displayName : displayNameFor(source, null);

  return (
    <div className={styles.app}>
      <ViewerBar
        name={name}
        onBack={back === null ? null : () => void goBackToPage(params)}
        // The error card carries its own "Open in Chrome's viewer"; one is enough on screen.
        onOpenInChrome={source === null || leaving || view.kind === 'error' ? null : () => escape(source)}
        chromeRefused={chromeRefused}
      />
      <div className={styles.content}>
        {leaving && (
          <p role="status" className={styles.status}>
            Opening in the full tab…
          </p>
        )}
        {view.kind === 'ready' && <Reader doc={view.doc} initialPage={params.page} onOpenInChrome={escape} />}
        {!leaving && view.kind === 'loading' && prompt === null && (
          <div role="progressbar" aria-label="Loading the PDF" className={styles.progress} />
        )}
        {view.kind === 'error' && !(fileAccess && fileDialogOpen) && (
          <LoadErrorCard error={view.error} sourceUrl={source} onOpenInChrome={escape} onImport={importFile} />
        )}
        {view.kind === 'bounced' && bounce !== null && <LargeFileNotice size={bounce.size} onOpenNow={bounce.openNow} />}
      </div>
      {fileAccess && (
        <FileAccessDialog open={fileDialogOpen} onOpenChange={setFileDialogOpen} onOpenSettings={openFileSettings} onChooseFile={importFile} />
      )}
      {prompt !== null && <PasswordDialog retry={prompt.retry} attempt={prompt.attempt} onSubmit={prompt.resolve} />}
    </div>
  );
}

/** "Open extension settings": the service worker opens chrome://extensions/?id=… beside this tab (a page cannot). */
function openFileSettings(): void {
  sendRuntimeMessage({ type: 'takeover:open-file-settings' }).catch(() => {
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });
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
