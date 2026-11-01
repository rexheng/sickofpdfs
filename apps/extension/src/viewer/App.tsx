// The viewer page: opens the PDF the address names, then shows its pages. One engine and one render queue per tab.
// It also owns the takeover's viewer side (Task 17): leaving a frame for the full tab (a viewer in a frame never loads
// the PDF there), "Back to page" for an embedded PDF, and the escape hatch to Chrome's own viewer. The chrome around
// the pages (Task 23) is Drive's: the header with its menus, the toolbar pill, the shortcut sheet and About; all of
// them run the commands in commands.ts.
// Phase 2 (S13): each page draws its marks under the text layer, the mark keys and the right-click mark-up menu act on
// the selection, and the notes features (comments, the notes panel) mount through annotations/wire.ts.
import '@sop/ui/tokens.css';
import '@sop/ui/base.css';
import { registerFonts } from '@sop/ui';
import {
  createEmbedPdfBackend,
  createPageTextProvider,
  createViewerStore,
  displayNameFor,
  ENGINE_WORKERS,
  engineAssets,
  type PageBox,
  PdfEngineCrashedError,
  PdfLoadError,
  RenderScheduler,
  ScanDetector,
  useViewerState,
  type ViewerSnapshot,
  type ViewerStore,
  type ZoomMode,
} from '@sop/viewer';
import { MarkLayer, type PageLayerContext, PageList, type PageListApi, TextLayer, TextLayerController } from '@sop/viewer/react';
import { memo, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sendRuntimeMessage } from '../shared/send-message';
import { parseViewerUrl, type ViewerParams } from '../shared/viewer-url';
import { copyLink } from './actions/copy-link';
import { MarkupMenu } from './annotations/MarkupMenu';
import { createNotes, type Notes, registerViewerFeature, viewerFeatures } from './annotations/wire';
import styles from './App.module.css';
import { backTarget, goBackToPage } from './back-to-page';
import { AboutDialog } from './chrome/AboutDialog';
import { Header } from './chrome/Header';
import { buildMenus } from './chrome/menus';
import { NavRail } from './chrome/NavRail';
import { ShortcutsDialog } from './chrome/ShortcutsDialog';
import { Snackbar } from './chrome/Snackbar';
import { Toolbar } from './chrome/Toolbar';
import { commandShortcuts, createCommands, createIdleCommands, type ViewerCommands, type ViewerContext, type ViewerUi } from './commands';
import { useReaderFind } from './find';
import { FormBanner, useFormBounce } from './forms/FormBanner';
import { maybeLeaveFrame, mayOfferNewTab, openInNewTab, wantsFullTab } from './frame-escape';
import { railStartsOpen, useOutline, useRailFitsWindow, useReaderNavigation } from './navigation';
import {
  type LargeFileBounce,
  type OpenDocumentDeps,
  type OpenedDocument,
  openDocument,
  type OpenOutcome,
  openPickedFile,
  reopenDocument,
} from './open-document';
import { notesPanelFeature } from './notes-panel/feature';
import { publishRuntime, type ViewerHooks, type ViewerState } from './runtime';
import { openInChrome } from './open-in-chrome';
import type { SaveControllerImpl } from './save/save-controller';
import { SaveAskDialog } from './save/SaveAskDialog';
import { StatusChip, useSaveView } from './save/StatusChip';
import { useSave } from './save/use-save';
import { PrintProgressDialog } from './print/PrintProgressDialog';
import { installShortcuts, type ShortcutDef } from './shortcuts';
import { EngineStoppedCard } from './ui/EngineStoppedCard';
import { FileAccessDialog } from './ui/FileAccessDialog';
import { FramedCard } from './ui/FramedCard';
import { LargeFileNotice } from './ui/LargeFileNotice';
import { CommentButton } from './notes/CommentButton';
import { commentsFeature } from './notes/feature';
import { LoadErrorCard } from './ui/LoadErrorCard';
import { LocalFileCard } from './ui/LocalFileCard';
import { PasswordDialog } from './ui/PasswordDialog';
import { ScanHint } from './ui/ScanHint';
import { useStore } from './use-store';

/**
 * The tab's one engine. Its worker starts at once, so PDFium is ready by the time the PDF has downloaded; not in a
 * frame, where the viewer never opens a PDF.
 */
const backend = createEmbedPdfBackend(engineAssets((p) => chrome.runtime.getURL(p)), { workers: ENGINE_WORKERS, startNow: window.top === window });

// Phase 2 features mount here, one line each: registerViewerFeature(<feature>) from './annotations/wire' (S14 comments,
// S15 the notes panel, S16 figures). Each gets the open document's notes (NotesHost) and draws beside or on the pages.
registerViewerFeature(commentsFeature);
registerViewerFeature(notesPanelFeature);

/** Where the reader was when the engine stopped, so the document opens again at the same place. */
type Resume = Pick<ViewerSnapshot, 'zoom' | 'currentPage' | 'viewRotation' | 'spread' | 'railOpen'>;

type View =
  | { kind: 'loading' }
  | Exclude<OpenOutcome, { kind: 'ready' }>
  | { kind: 'ready'; doc: OpenedDocument; resume?: Resume }
  /** The engine stopped, and opening the document again did not help. */
  | { kind: 'stopped' };

let currentView: View = { kind: 'loading' };
publishRuntime({
  backend,
  doc: () => (currentView.kind === 'ready' ? currentView.doc : null),
  viewerState: (): ViewerState => (currentView.kind === 'refused' || currentView.kind === 'stopped' ? 'error' : currentView.kind),
});

interface PasswordPrompt {
  retry: boolean;
  attempt: number;
  resolve: (password: string | null) => void;
}

export function App() {
  const params = useMemo(() => parseViewerUrl(location.href), []);
  return wantsFullTab(params) ? <FramedViewer params={params} /> : <TabViewer params={params} />;
}

/**
 * The viewer in a frame of some page (a PDF in an `<iframe>`). It never loads the PDF there: it asks for the whole tab,
 * and when the service worker says no, it offers a new tab.
 */
function FramedViewer({ params }: { params: ViewerParams }) {
  const [stay, setStay] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void registerFonts().catch(() => {});
    maybeLeaveFrame(params, () => setStay(true));
  }, [params]);
  useEffect(() => {
    document.title = displayNameFor(params.source, null);
  }, [params]);
  const source = params.source;
  return (
    <div className={styles.app}>
      <div className={styles.frameContent}>
        {stay ? (
          <FramedCard
            name={displayNameFor(source, null)}
            onOpenInNewTab={source !== null && mayOfferNewTab(params) ? () => openInNewTab(source) : null}
          />
        ) : (
          <p role="status" className={styles.status}>
            Opening in the full tab…
          </p>
        )}
      </div>
    </div>
  );
}

/** The viewer that fills the tab. */
function TabViewer({ params }: { params: ViewerParams }) {
  const [view, setView] = useState<View>(currentView);
  const [prompt, setPrompt] = useState<PasswordPrompt | null>(null);
  const [bounce, setBounce] = useState<LargeFileBounce | null>(null);
  const [fileDialogOpen, setFileDialogOpen] = useState(true);
  const [chromeRefused, setChromeRefused] = useState(false);
  // "Back to page": only the page the service worker saw embed this PDF in this tab (back-to-page.ts).
  const [backPage, setBackPage] = useState<string | null>(null);
  const attempts = useRef(0);
  const started = useRef(false);
  const restarted = useRef(false);
  useStore(view.kind === 'ready');

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
      onBackPage: setBackPage,
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

  /**
   * The engine stopped under the open document (a crash, a hang past the watchdog, or no memory): its pages could no
   * longer be drawn. It is opened again once, from the bytes the viewer holds, at the same place; if that fails, or
   * the engine stops again, the owner gets a plain card. One log line each time, never one per page or redraw.
   */
  const onEngineStopped = useCallback(
    (err: PdfEngineCrashedError, resume: Resume) => {
      const was = currentView;
      if (was.kind !== 'ready') return;
      if (restarted.current) {
        console.error(`sickofpdfs: the PDF engine stopped again (${err.reason})`);
        show({ kind: 'stopped' });
        return;
      }
      restarted.current = true;
      console.error(`sickofpdfs: the PDF engine stopped (${err.reason}); opening the document again`);
      reopenDocument(was.doc, backend).then(
        (doc) => show({ kind: 'ready', doc, resume }),
        () => show({ kind: 'stopped' }),
      );
    },
    [show],
  );

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
  const back = backTarget(backPage);
  const source = params.source;
  const name = view.kind === 'ready' ? view.doc.loaded.displayName : displayNameFor(source, null);

  // The chrome: dialogs, the page box (Ctrl+G), the copy-link note, and the commands everything runs.
  const root = useRef<HTMLDivElement>(null);
  const pageField = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<'shortcuts' | 'about' | null>(null);
  const [note, setNote] = useState<{ text: string } | null>(null);
  const [printing, setPrinting] = useState<{ done: number; total: number; cancel: () => void } | null>(null);
  const ui = useMemo<ViewerUi>(
    () => ({
      openInChrome: escape,
      focusPageField: () => {
        pageField.current?.focus();
        pageField.current?.select();
      },
      showShortcuts: () => setDialog('shortcuts'),
      showAbout: () => setDialog('about'),
      copyLink: (link) => void copyLink(link).then((ok) => setNote({ text: ok ? 'Link copied' : 'Couldn’t copy the link. Try again.' })),
      printProgress: setPrinting,
      showNote: (text) => setNote({ text }),
    }),
    [escape],
  );
  // The library save (Task 30): the status chip, the first-mark question, and then the form check (Task 31).
  const opened = view.kind === 'ready' ? view.doc : null;
  const onSaveFailure = useCallback(
    (what: 'save' | 'forget') => setNote({ text: what === 'save' ? 'Couldn’t save this PDF to your library. Try again.' : 'Couldn’t undo the save. Try again.' }),
    [],
  );
  const save = useSave({ opened, params, backend, onFailure: onSaveFailure });
  const form = useFormBounce({ opened, save, source, backend });
  const [reader, setReader] = useState<ReaderChrome | null>(null);
  // Not for a local file the tab was not seen opening: one click must not show it in Chrome's viewer either.
  const canEscape = source !== null && view.kind !== 'refused';
  const idleCommands = useMemo(() => createIdleCommands({ source, canOpenInChrome: canEscape, ui }), [source, canEscape, ui]);
  const live = view.kind === 'ready' ? reader : null;
  const commands = live?.commands ?? idleCommands;
  useEffect(() => installShortcuts(commandShortcuts(commands)), [commands]);
  // The menus read each command's state when they are built: build them again whenever the view changes.
  const viewVersion = useViewVersion(live?.store ?? null);
  const saveKind = useSaveView(save).state?.kind; // File → Save to library follows the save state
  const menus = useMemo(() => buildMenus(commands), [commands, viewVersion, saveKind]); // eslint-disable-line react-hooks/exhaustive-deps -- viewVersion and saveKind are the triggers

  return (
    <div ref={root} className={styles.app}>
      <Header
        name={name}
        onBack={back === null ? null : () => void goBackToPage(back)}
        menus={menus}
        // The error and stopped cards carry their own "Open in Chrome's viewer"; one is enough on screen.
        onOpenInChrome={!canEscape || view.kind === 'error' || view.kind === 'stopped' ? null : () => escape(source)}
        chromeRefused={chromeRefused}
        status={save !== null && <StatusChip save={save} />}
      />
      <div className={styles.content}>
        {view.kind === 'ready' && (
          <Reader
            key={view.doc.open.doc}
            doc={view.doc}
            resume={view.resume}
            params={params}
            rootRef={root}
            pageFieldRef={pageField}
            ui={ui}
            save={save}
            onChrome={setReader}
            onEngineStopped={onEngineStopped}
          />
        )}
        {view.kind === 'ready' && form.notice !== null && <FormBanner kind={form.notice} onDismiss={form.dismiss} />}
        {view.kind === 'loading' && prompt === null && (
          <div role="progressbar" aria-label="Loading the PDF" className={styles.progress} />
        )}
        {view.kind === 'error' && !(fileAccess && fileDialogOpen) && (
          <LoadErrorCard
            error={view.error}
            sourceUrl={source}
            onOpenInChrome={escape}
            onImport={importFile}
            // Fetched without the owner's sign-in: "Try again" sends the tab to the address itself, as a click on the
            // link would, and the takeover then opens it with the sign-in (or the site shows its own sign-in page).
            onTryAgain={view.signedOut && source !== null && /^https?:/i.test(source) ? () => location.replace(source) : undefined}
          />
        )}
        {view.kind === 'refused' && <LocalFileCard onChooseFile={importFile} />}
        {view.kind === 'stopped' && <EngineStoppedCard onReload={() => location.reload()} onOpenInChrome={source === null ? null : () => escape(source)} />}
        {view.kind === 'bounced' && bounce !== null && <LargeFileNotice size={bounce.size} onOpenNow={bounce.openNow} />}
      </div>
      {fileAccess && (
        <FileAccessDialog open={fileDialogOpen} onOpenChange={setFileDialogOpen} onOpenSettings={openFileSettings} onChooseFile={importFile} />
      )}
      {prompt !== null && <PasswordDialog retry={prompt.retry} attempt={prompt.attempt} onSubmit={prompt.resolve} />}
      <ShortcutsDialog open={dialog === 'shortcuts'} onOpenChange={(open) => !open && setDialog(null)} commands={commands} />
      <AboutDialog open={dialog === 'about'} onOpenChange={(open) => !open && setDialog(null)} />
      <SaveAskDialog save={save} />
      {printing !== null && <PrintProgressDialog done={printing.done} total={printing.total} onCancel={printing.cancel} />}
      <Snackbar note={note} />
    </div>
  );
}

/** What the open document hands up to the header: its commands and the view state they read. */
interface ReaderChrome {
  commands: ViewerCommands;
  store: ViewerStore;
}

/** The view state while no document is open: it never changes. */
const IDLE_STORE = createViewerStore();

/**
 * Changes whenever something a menu shows may have changed (zoom, rotation, spread, the rail), so the menus are built
 * again.
 */
function useViewVersion(store: ViewerStore | null): string {
  return useViewerState(store ?? IDLE_STORE, (s) => `${s.zoom.kind}|${s.scale}|${s.viewRotation}|${s.spread}|${s.railOpen}`);
}

/** "Open extension settings": the service worker opens chrome://extensions/?id=… beside this tab (a page cannot). */
function openFileSettings(): void {
  sendRuntimeMessage({ type: 'takeover:open-file-settings' }).catch(() => {
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });
}

interface ReaderProps {
  doc: OpenedDocument;
  /** Where to open after the engine was started again; otherwise the address's page, fit width. */
  resume?: Resume | undefined;
  params: ViewerParams;
  rootRef: RefObject<HTMLDivElement | null>;
  pageFieldRef: RefObject<HTMLInputElement | null>;
  ui: ViewerUi;
  /** The library save (Task 30): made when the PDF opens, in `checking` until the store answers. */
  save: SaveControllerImpl | null;
  /** The commands for this document and its view state, for the header's menus and the keys; null when it goes. */
  onChrome: (chrome: ReaderChrome | null) => void;
  /** The engine stopped under this document: called once, with where the reader was. */
  onEngineStopped: (err: PdfEngineCrashedError, resume: Resume) => void;
}

/**
 * The open document: the toolbar pill, the navigation rail, the page list with its links, its keys, the scan hint, and
 * its test hooks. Memoised: the header re-renders App when the view changes (its menus), and that must not re-render
 * the page list.
 */
const Reader = memo(function Reader({ doc, resume, params, rootRef, pageFieldRef, ui, save, onChrome, onEngineStopped }: ReaderProps) {
  const [store] = useState(() =>
    createViewerStore({ currentPage: Math.min(doc.open.pageCount - 1, Math.max(0, (params.page ?? 1) - 1)), railOpen: railStartsOpen(), ...resume }),
  );
  const [scheduler] = useState(
    () => new RenderScheduler(backend, doc.open.doc, { concurrency: ENGINE_WORKERS, previewWidthPx: 160, previewCache: 300 }),
  );
  const [scans] = useState(() => new ScanDetector(backend, doc.open.doc, doc.open.pages));
  // The page text everything reads (the text layer now; marks and find later): one glyph cache for the document.
  const [pageText] = useState(() => createPageTextProvider(backend, doc.open.doc));
  const [textLayers] = useState(() => new TextLayerController({ source: pageText, pages: doc.open.pages, fontUrl: chrome.runtime.getURL(TEXT_LAYER_FONT) }));
  const api = useRef<PageListApi | null>(null);
  const nav = useReaderNavigation({ backend, doc, store, api });
  const outline = useOutline(backend, doc);
  useRailFitsWindow(store);
  // Find jumps through the same history as links, so Back returns from each jump to a hit (Task 25).
  const find = useReaderFind({ backend, doc, store, api, pageText, textLayers, jumps: nav.jumps, root: rootRef });
  // The document's notes: marks, comments and drafts (Phase 2). Null in Incognito, which has none.
  const notes = useNotes(doc, pageText, store, api, textLayers, save);
  const commands = useMemo(() => {
    const ctx: ViewerContext = {
      params,
      backend,
      opened: doc,
      store,
      scheduler,
      root: rootRef.current ?? document.body,
      jumps: nav.jumps,
      find: find.controller,
      openFind: find.open,
      save,
      pageList: api,
      ui,
    };
    return createCommands(ctx, notes?.behaviours() ?? {});
  }, [params, doc, store, scheduler, rootRef, ui, save, nav.jumps, find.controller, find.open, notes]);
  useEffect(() => {
    onChrome({ commands, store });
    return () => onChrome(null);
  }, [commands, store, onChrome]);
  useEffect(() => installShortcuts(readerShortcuts(api)), []);
  useEffect(() => () => textLayers.dispose(), [textLayers]);
  useEffect(
    () =>
      publishRuntime({
        viewer: viewerHooks(api, store, scans, textLayers),
        selectionRanges: () => textLayers.selectionRanges(),
        glyphCenter: (pageIndex, charIndex) => textLayers.glyphCenter(pageIndex, charIndex),
      }),
    [store, scans, textLayers],
  );
  // Each page, bottom to top: its marks (and bold) and the features' page layers (Phase 2), find's highlights (Task 25),
  // the selection and the text layer, then the links (Task 24).
  const findLayer = find.pageLayer;
  const linksFor = nav.renderPage;
  const bold = useMemo(() => ({ backend, doc: doc.open.doc, text: pageText }), [doc, pageText]);
  const renderPage = useCallback(
    (box: PageBox, ctx: PageLayerContext) => (
      <>
        {notes !== null && <MarkLayer source={notes.layer} box={box} ctx={ctx} page={doc.open.pages[box.index]} bold={bold} />}
        {notes !== null && viewerFeatures().map((f) => f.PageLayer && <f.PageLayer key={f.id} host={notes.host} box={box} ctx={ctx} />)}
        {findLayer(box, ctx)}
        <TextLayer controller={textLayers} box={box} ctx={ctx} />
        {linksFor(box)}
      </>
    ),
    [textLayers, findLayer, linksFor, notes, doc, bold],
  );
  // Every render still waiting fails at once when the engine stops: the first one tells the viewer, the rest are quiet.
  const stopped = useRef(false);
  const onDrawError = useCallback(
    (err: unknown) => {
      if (!(err instanceof PdfEngineCrashedError)) {
        console.error('sickofpdfs: a page could not be drawn', err);
        return;
      }
      if (stopped.current) return;
      stopped.current = true;
      const { zoom, currentPage, viewRotation, spread, railOpen } = store.get();
      onEngineStopped(err, { zoom, currentPage, viewRotation, spread, railOpen });
    },
    [store, onEngineStopped],
  );
  // R60: room the features keep at the right from the first layout (a PDF that already has notes opens with its margin).
  const [reserveAtOpen] = useState(() => Math.max(0, ...viewerFeatures().map((f) => f.reserveAtOpen?.(doc) ?? 0)));
  const goToPage = useCallback((index: number) => void api.current?.goToPage(index), []);
  const zoom = useCallback((mode: ZoomMode) => api.current?.zoomTo(mode), []);
  return (
    <>
      <Toolbar
        commands={commands}
        store={store}
        pageCount={doc.open.pageCount}
        onGoToPage={goToPage}
        onZoom={zoom}
        pageFieldRef={pageFieldRef}
        end={<><CurrentPageExtras store={store} scans={scans} source={doc.loaded.sourceUrl} onOpenInChrome={(url) => ui.openInChrome(url)} /><CommentButton /></>}
      />
      <NavRail
        store={store}
        scheduler={scheduler}
        pages={doc.open.pages}
        outline={outline}
        onPage={nav.onPage}
        onOutline={nav.onOutline}
        onToggle={() => commands.get('view.toggleRail')?.run()}
      >
        <PageList backend={backend} doc={doc} store={store} scheduler={scheduler} apiRef={api} renderPage={renderPage} onError={onDrawError} initialReserveRight={reserveAtOpen} />
      </NavRail>
      {find.view}
      {notes !== null && viewerFeatures().map((f) => f.View && <f.View key={f.id} host={notes.host} />)}
      {notes !== null && <MarkupMenu input={notes.input} commands={commands} />}
    </>
  );
});

/**
 * The open document's notes, made once the page list is up and the save controller exists (one render after the PDF is
 * ready), and disposed with the document. In Incognito there are none (null). Published to the test hooks as
 * `annotations`. Whether they are written is wire.ts's notesSaveGate.
 */
function useNotes(
  doc: OpenedDocument,
  pageText: ReturnType<typeof createPageTextProvider>,
  view: ViewerStore,
  pageList: RefObject<PageListApi | null>,
  textLayers: TextLayerController,
  save: SaveControllerImpl | null,
): Notes | null {
  const [notes, setNotes] = useState<Notes | null>(null);
  useEffect(() => {
    if (save === null) return;
    const made = createNotes({ backend, opened: doc, pageText, view, pageList, selection: () => textLayers.selectionRanges(), save });
    setNotes(made);
    publishRuntime({ annotations: made?.host.session ?? null });
    return () => {
      made?.dispose();
      setNotes(null);
      publishRuntime({ annotations: null });
    };
  }, [doc, pageText, view, pageList, textLayers, save]);
  return notes;
}

/** The text layer's font: the engine's bundled Noto Sans (the spike measured canvas and DOM widths within 0.02 px with it). */
const TEXT_LAYER_FONT = 'pdf/NotoSans-Regular.ttf';

/** What follows the page in view: `#page=N` in the address, and the scan hint. Kept apart so the page list does not re-render. */
function CurrentPageExtras(p: { store: ViewerStore; scans: ScanDetector; source: string | null; onOpenInChrome: (url: string) => void }) {
  const currentPage = useViewerState(p.store, (s) => s.currentPage);
  const scanned = useScannedPage(p.scans, currentPage);
  usePageHash(currentPage);
  const { source, onOpenInChrome } = p;
  return <ScanHint shown={scanned && source !== null} onOpenInChrome={() => source !== null && onOpenInChrome(source)} />;
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

/**
 * A button of the header or the toolbar pill has the focus, as it does after a click there (or after a menu closes, when
 * Radix puts the focus back on its button). Such a button only uses Enter, Space and Left/Right itself (and a menu
 * button ArrowDown), so Page Up/Down, Home and End still move the pages, as they do in Chrome's viewer.
 */
function onChromeButton(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLButtonElement && a.closest('[data-viewer-chrome]') !== null;
}

/** Up and Down too, except on a menu-bar button, where Down opens its menu. */
function onChromeButtonNotMenu(): boolean {
  return onChromeButton() && document.activeElement?.getAttribute('role') !== 'menuitem';
}

/** Chromium's viewer scroll keys. (The zoom keys are commands: commands.ts.) */
function readerShortcuts(api: RefObject<PageListApi | null>): ShortcutDef[] {
  const on = (f: (a: PageListApi) => void) => () => {
    if (api.current) f(api.current);
  };
  const def = (enabled: () => boolean) => (id: string, keys: string[], f: (a: PageListApi) => void): ShortcutDef => ({ id, keys, run: on(f), enabled });
  const page = def(inPageArea);
  const vertical = def(() => inPageArea() || onChromeButton());
  const line = def(() => inPageArea() || onChromeButtonNotMenu());
  return [
    line('scroll.lineDown', ['ArrowDown'], (a) => a.scrollLines(1)),
    line('scroll.lineUp', ['ArrowUp'], (a) => a.scrollLines(-1)),
    vertical('scroll.screenDown', ['PageDown'], (a) => a.scrollScreens(1)),
    page('scroll.screenDown', ['Space'], (a) => a.scrollScreens(1)),
    vertical('scroll.screenUp', ['PageUp'], (a) => a.scrollScreens(-1)),
    page('scroll.screenUp', ['Shift+Space'], (a) => a.scrollScreens(-1)),
    vertical('scroll.start', ['Home'], (a) => a.goToStart()),
    vertical('scroll.end', ['End'], (a) => a.goToEnd()),
    page('scroll.left', ['ArrowLeft'], (a) => a.scrollSideways(-1)),
    page('scroll.right', ['ArrowRight'], (a) => a.scrollSideways(1)),
  ];
}

/** How long viewer.scrollTo waits for the page's full render before giving up. */
const SCROLL_TO_TIMEOUT_MS = 10_000;

function viewerHooks(api: RefObject<PageListApi | null>, store: ViewerStore, scans: ScanDetector, textLayers: TextLayerController): ViewerHooks {
  const a = () => api.current;
  return {
    scale: () => store.get().scale,
    setScale: (s) => a()?.zoomTo({ kind: 'scale', scale: s }),
    currentPage: () => store.get().currentPage,
    scrollTo: (i) =>
      Promise.race([
        (a()?.goToPage(i) ?? Promise.resolve()).then(() => textLayers.whenReady(i)),
        new Promise<void>((resolve) => setTimeout(resolve, SCROLL_TO_TIMEOUT_MS)),
      ]),
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
