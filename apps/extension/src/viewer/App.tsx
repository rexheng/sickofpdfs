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
  type JumpHistory,
  type PageBox,
  PdfEngineCrashedError,
  PdfLoadError,
  RenderScheduler,
  ScanDetector,
  START_ZOOM,
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
import { CARET_OFF_NOTE, CARET_ON_NOTE, caretBrowsingSwitch, useCaretBrowsing } from './caret-browsing';
import { AboutDialog } from './chrome/AboutDialog';
import { Header } from './chrome/Header';
import { useCompactToolbar } from './chrome/compact';
import { buildMenus } from './chrome/menus';
import { useReadingTitle } from './chrome/reading-title';
import { NavRail } from './chrome/NavRail';
import { ShortcutsDialog } from './chrome/ShortcutsDialog';
import { Snackbar, type SnackbarNote } from './chrome/Snackbar';
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
  pickedFileName,
  reopenDocument,
} from './open-document';
import { notesPanelFeature } from './notes-panel/feature';
import { useReadingHistory } from './history/use-reading-history';
import { hitFlashFeature } from './hit-flash';
import { createHitJumper, type HitJumper, useOpenTarget } from './jump-to-hit';
import { openSavedCopy, savedCopyName } from './open-saved';
import { useOriginalLink } from './original-link';
import { ViewerPalette } from './palette-host';
import { publishRuntime, type ViewerHooks, type ViewerState } from './runtime';
import { atPage, openInChrome } from './open-in-chrome';
import { settlePresentation } from './presentation';
import type { SaveControllerImpl } from './save/save-controller';
import { NotSureBanner } from './save/NotSureBanner';
import { saveDecisionCommands } from './save/save-commands';
import { SaveAskDialog } from './save/SaveAskDialog';
import { SaveDialogs } from './save/SaveDialogs';
import { StatusChip, useSaveView } from './save/StatusChip';
import { useSave } from './save/use-save';
import { PrintMarksDialog } from './print/PrintMarksDialog';
import { PrintProgressDialog } from './print/PrintProgressDialog';
import { installShortcuts, type ShortcutDef } from './shortcuts';
import { EngineStoppedCard } from './ui/EngineStoppedCard';
import { FileAccessDialog } from './ui/FileAccessDialog';
import { FramedCard } from './ui/FramedCard';
import { LargeFileNotice } from './ui/LargeFileNotice';
import { CommentButton } from './notes/CommentButton';
import { commentsFeature } from './notes/feature';
import { AreaToolButton } from './figures/AreaToolButton';
import { figuresFeature } from './figures/feature';
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
registerViewerFeature(figuresFeature);
// Phase 3 (S15): the words a search jump landed on, picked out for a moment.
registerViewerFeature(hitFlashFeature);

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
    // A saved copy (`?doc=`, from the library or the search palette) is read from the extension's own storage.
    void (params.doc ? openSavedCopy(params, deps) : openDocument(params, deps)).then(show);
  }, [params, deps, show]);

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

  /**
   * The escape hatch: this address in Chrome's own viewer, once, at the page the reader is on (`page`, 1-based).
   * Chrome refuses a local file without file access.
   */
  const escape = useCallback((url: string, page?: number) => {
    setChromeRefused(false);
    void openInChrome(atPage(url, page)).then((ok) => setChromeRefused(!ok));
  }, []);
  const fileAccess = view.kind === 'error' && view.error instanceof PdfLoadError && view.error.code === 'file-access';
  const back = backTarget(backPage);
  const source = params.source;

  // The chrome: dialogs, the page box (Ctrl+G), the copy-link note, and the commands everything runs.
  const root = useRef<HTMLDivElement>(null);
  const focusPages = useFocusBackToPages(root);
  useKeyboardFocusMark();
  const pageField = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<'shortcuts' | 'about' | null>(null);
  const [note, setNote] = useState<SnackbarNote | null>(null);
  const [printing, setPrinting] = useState<{ done: number; total: number; cancel: () => void } | null>(null);
  const [printAsk, setPrintAsk] = useState<{ answer(this: void, choice: 'with' | 'without' | null): void } | null>(null);
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
      askPrintMarks: () =>
        new Promise((resolve) =>
          setPrintAsk({
            answer: (choice) => {
              setPrintAsk(null);
              resolve(choice);
            },
          }),
        ),
      showNote: (text, action) => setNote(action === undefined ? { text } : { text, action }),
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
  // The tab and the header name the reading: its real title once known, the file name until then (chrome/reading-title.ts).
  const title = useReadingTitle(opened, save);
  const name = title?.shown ?? (pickedFileName(params) ?? savedCopyName(params) ?? displayNameFor(source, null));
  useEffect(() => {
    document.title = name;
  }, [name]);
  const form = useFormBounce({ opened, save, source, backend });
  const [reader, setReader] = useState<ReaderChrome | null>(null);
  // Not for a local file the tab was not seen opening: one click must not show it in Chrome's viewer either.
  const canEscape = source !== null && view.kind !== 'refused';
  const idleReason = view.kind === 'loading' ? 'wait for the PDF to open' : 'no PDF is open';
  const idleCommands = useMemo(
    () => createIdleCommands({ source, canOpenInChrome: canEscape, ui, reason: idleReason }),
    [source, canEscape, ui, idleReason],
  );
  const live = view.kind === 'ready' ? reader : null;
  const commands = live?.commands ?? idleCommands;
  useEffect(() => installShortcuts(commandShortcuts(commands)), [commands]);
  // The menus read each command's state when they are built: build them again whenever the view changes.
  const viewVersion = useViewVersion(live?.store ?? null);
  const saveKind = useSaveView(save).state?.kind; // File → Save to library follows the save state
  const caretOn = useCaretBrowsing(); // View → Caret browsing shows its check
  const menus = useMemo(() => buildMenus(commands), [commands, viewVersion, saveKind, caretOn]); // eslint-disable-line react-hooks/exhaustive-deps -- viewVersion, saveKind and caretOn are the triggers

  return (
    <div ref={root} className={styles.app}>
      <Header
        name={name}
        hint={title === null ? name : title.full === title.fileName ? title.fileName : `${title.full}\n${title.fileName}`}
        onBack={back === null ? null : () => void goBackToPage(back)}
        menus={menus}
        // The error and stopped cards carry their own "Open in Chrome's viewer"; one is enough on screen.
        onOpenInChrome={!canEscape || view.kind === 'error' || view.kind === 'stopped' ? null : () => escape(source, (live?.store.get().currentPage ?? 0) + 1)}
        chromeRefused={chromeRefused}
        status={save !== null && <StatusChip save={save} returnFocus={focusPages} />}
        returnFocus={focusPages}
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
            returnFocus={focusPages}
          />
        )}
        {/* The pill is there from the start, in its place, so it does not pop in when the PDF arrives. */}
        {view.kind === 'loading' && <Toolbar commands={idleCommands} view={null} />}
        {view.kind === 'ready' && form.notice !== null && <FormBanner kind={form.notice} onDismiss={form.dismiss} />}
        {view.kind === 'ready' && form.notice === null && <NotSureBanner save={save} ui={ui} />}
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
            onTryAgain={
              view.signedOut && source !== null && /^https?:/i.test(source)
                ? () => location.replace(source)
                : // The download stopped part way: one more try may work ("Check your connection, then try again").
                  view.error instanceof PdfLoadError && view.error.code === 'network' && source !== null
                  ? () => location.reload()
                  : undefined
            }
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
      <ViewerPalette commands={commands} jumper={live?.jumper ?? null} ui={ui} />
      <SaveAskDialog save={save} />
      {printAsk !== null && <PrintMarksDialog onAnswer={printAsk.answer} />}
      <SaveDialogs save={save} ui={ui} />
      {printing !== null && <PrintProgressDialog done={printing.done} total={printing.total} onCancel={printing.cancel} />}
      <Snackbar note={note} />
    </div>
  );
}

/**
 * Gives the focus back to the pages after the pointer used the chrome: a header or toolbar button clicked, or a menu
 * closed with the pointer (MenuBar's and DropdownMenu's `returnFocus`). The button would otherwise keep the focus:
 * Space would press it again, the arrows would not scroll, and a ring would be left on it. A button pressed from the
 * keyboard keeps the focus and its ring. The find bar keeps its own focus (its buttons step through the hits).
 * Returns the function that moves the focus, for the menus.
 */
function useFocusBackToPages(root: RefObject<HTMLDivElement | null>): () => void {
  const focusPages = useCallback(() => {
    const pages = root.current?.querySelector<HTMLElement>('[role="document"]');
    if (pages) pages.focus({ preventScroll: true });
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); // no pages yet: the page itself
  }, [root]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return; // Enter or Space on the button: the keyboard keeps its place
      const button = e.target instanceof Element ? e.target.closest('button') : null;
      if (button === null || button.closest('[data-viewer-chrome]') === null || button.closest('[role="search"]') !== null) return;
      // After the button's own action, which may have moved the focus itself (a dialog, the page box, a menu).
      setTimeout(() => {
        if (document.activeElement === button) focusPages();
      }, 0);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [focusPages]);
  return focusPages;
}

/**
 * Marks the pages (`data-keyboard-focus`) while the keyboard brought the focus to them (Tab, Shift+Tab), so their
 * focus ring shows then and only then (NavRail.module.css). A click on the pages, or the focus handed back after a
 * toolbar click, shows none: the ring was noise for mouse readers, and Chrome's :focus-visible would show it as soon
 * as a reading key was pressed.
 */
function useKeyboardFocusMark(): void {
  useEffect(() => {
    let tabbed = false;
    const isPages = (t: EventTarget | null): t is HTMLElement => t instanceof HTMLElement && t.getAttribute('role') === 'document';
    const onKeyDown = (e: KeyboardEvent) => {
      tabbed = e.key === 'Tab';
    };
    const onPointerDown = () => {
      tabbed = false;
      document.querySelector('[data-keyboard-focus]')?.removeAttribute('data-keyboard-focus');
    };
    const onFocusIn = (e: FocusEvent) => {
      if (isPages(e.target)) e.target.toggleAttribute('data-keyboard-focus', tabbed);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (isPages(e.target)) e.target.removeAttribute('data-keyboard-focus');
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);
}

/** What the open document hands up to the header: its commands and the view state they read. */
interface ReaderChrome {
  commands: ViewerCommands;
  store: ViewerStore;
  /** Shows a search hit in this document (S15). */
  jumper: HitJumper;
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
  /** Gives the focus back to the pages after the zoom list was used with the pointer. */
  returnFocus: () => void;
}

/**
 * The open document: the toolbar pill, the navigation rail, the page list with its links, its keys, the scan hint, and
 * its test hooks. Memoised: the header re-renders App when the view changes (its menus), and that must not re-render
 * the page list.
 */
const Reader = memo(function Reader({ doc, resume, params, rootRef, pageFieldRef, ui, save, onChrome, onEngineStopped, returnFocus }: ReaderProps) {
  const [store] = useState(() =>
    createViewerStore({
      // Ruling R61: fit width, but no larger than 100%, as Chrome's and Drive's viewers open (a narrow window goes below).
      zoom: START_ZOOM,
      currentPage: Math.min(doc.open.pageCount - 1, Math.max(0, (params.page ?? 1) - 1)),
      railOpen: railStartsOpen() && !viewerFeatures().some((f) => f.foldsRailAtOpen?.(doc)),
      ...resume,
    }),
  );
  const [scheduler] = useState(
    () => new RenderScheduler(backend, doc.open.doc, { concurrency: ENGINE_WORKERS, previewWidthPx: 160, previewCache: 300 }),
  );
  const [scans] = useState(() => new ScanDetector(backend, doc.open.doc, doc.open.pages));
  // The page text everything reads (the text layer now; marks and find later): one glyph cache for the document.
  const [pageText] = useState(() => createPageTextProvider(backend, doc.open.doc));
  const api = useRef<PageListApi | null>(null);
  const [textLayers] = useState(
    () =>
      new TextLayerController({
        source: pageText,
        pages: doc.open.pages,
        fontUrl: chrome.runtime.getURL(TEXT_LAYER_FONT),
        onNote: (text) => ui.showNote(text),
        // Caret browsing (R93) moves through the page list, and leaves presentation mode its keys.
        pageList: () => api.current,
        paused: () => store.get().presenting !== null,
        isScannedPage: (i) => scans.isScannedPage(i),
      }),
  );
  useEffect(() => {
    textLayers.caret.setEnabled(caretBrowsingSwitch.get());
    return caretBrowsingSwitch.subscribe(() => textLayers.caret.setEnabled(caretBrowsingSwitch.get()));
  }, [textLayers]);
  const nav = useReaderNavigation({ backend, doc, store, api });
  const outline = useOutline(backend, doc);
  useRailFitsWindow(store);
  // Find jumps through the same history as links, so Back returns from each jump to a hit (Task 25).
  const find = useReaderFind({ backend, doc, store, api, pageText, textLayers, jumps: nav.jumps, root: rootRef, scans });
  // The document's notes: marks, comments and drafts (Phase 2). Null in Incognito, which has none.
  const notes = useNotes(doc, pageText, store, api, textLayers, save, nav.jumps, ui);
  // Reading time, the last spot and the pages visited (kept once the PDF is saved), and the return to the last spot.
  useReadingHistory({ doc, params, view: store, pageList: api, save, ui, restarted: resume !== undefined });
  const originalLink = useOriginalLink(params);
  const commands = useMemo(() => {
    const ctx: ViewerContext = {
      originalLink,
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
      printMarks: notes === null ? null : { layer: notes.layer, text: pageText },
      caretBrowsing: { on: caretBrowsingSwitch.get, toggle: () => ui.showNote(caretBrowsingSwitch.toggle() ? CARET_ON_NOTE : CARET_OFF_NOTE) },
      ui,
    };
    return createCommands(ctx, { ...notes?.behaviours(), ...saveDecisionCommands(save) });
  }, [params, doc, store, scheduler, rootRef, ui, save, nav.jumps, find.controller, find.open, notes, pageText, originalLink]);
  // Search hits in this document (S15): a jump in place, through the same history as links and find.
  const jumper = useMemo(
    () =>
      createHitJumper({
        api,
        text: pageText,
        pages: doc.open.pages,
        jumps: nav.jumps,
        view: store,
        session: notes?.host.session ?? null,
        documentId: () => (save?.state.kind === 'saved' ? save.state.documentId : null),
      }),
    [pageText, doc, nav.jumps, store, notes, save],
  );
  // What the address of a saved copy asked for: its note, or its words on the page.
  const settled = useMemo(() => (notes === null ? null : () => notes.host.notesSettled()), [notes]);
  const say = useCallback((text: string) => ui.showNote(text), [ui]);
  useOpenTarget({ params, jumper, api, settled, say });
  useEffect(() => {
    onChrome({ commands, store, jumper });
    return () => onChrome(null);
  }, [commands, store, jumper, onChrome]);
  useEffect(() => installShortcuts(readerShortcuts(api, () => textLayers.caret.takesKeys())), [textLayers]);
  useEffect(() => () => textLayers.dispose(), [textLayers]);
  useEffect(
    () =>
      publishRuntime({
        viewer: viewerHooks(api, store, scans, textLayers),
        selectionRanges: () => textLayers.selectionRanges(),
        glyphCenter: (pageIndex, charIndex) => textLayers.glyphCenter(pageIndex, charIndex),
        caret: () => ({ on: textLayers.caret.enabled, position: textLayers.caret.position() }),
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
  const toolbarView = useMemo(
    () => ({ store, pageCount: doc.open.pageCount, onGoToPage: goToPage, onZoom: zoom, pageFieldRef }),
    [store, doc, goToPage, zoom, pageFieldRef],
  );
  const compact = useCompactToolbar();
  return (
    <>
      <Toolbar
        commands={commands}
        view={toolbarView}
        returnFocus={returnFocus}
        // In the compact pill (a narrow window) Area note is a row of its "More" menu instead (chrome/compact.ts).
        end={<><CurrentPageExtras store={store} scans={scans} source={doc.loaded.sourceUrl} onOpenInChrome={(url, page) => ui.openInChrome(url, page)} />{!compact && <AreaToolButton commands={commands} />}<CommentButton /></>}
      />
      <NavRail
        store={store}
        scheduler={scheduler}
        pages={doc.open.pages}
        outline={outline}
        onPage={nav.onPage}
        onOutline={nav.onOutline}
        onToggle={() => commands.get('view.toggleRail')?.run()}
        tabs={notes === null ? undefined : viewerFeatures().flatMap((f) => (f.rail ? [{ id: f.id, icon: f.rail.icon, label: f.rail.label, panel: <f.rail.Panel host={notes.host} /> }] : []))}
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
  jumps: JumpHistory,
  ui: ViewerUi,
): Notes | null {
  const [notes, setNotes] = useState<Notes | null>(null);
  useEffect(() => {
    if (save === null) return;
    const made = createNotes({ backend, opened: doc, pageText, view, pageList, jumps, textSelection: textLayers.textSelection, showNote: (text) => ui.showNote(text), save });
    setNotes(made);
    publishRuntime({ annotations: made?.host.session ?? null });
    return () => {
      made?.dispose();
      setNotes(null);
      publishRuntime({ annotations: null });
    };
  }, [doc, pageText, view, pageList, textLayers, save, jumps, ui]);
  return notes;
}

/** The text layer's font: the engine's bundled Noto Sans (the spike measured canvas and DOM widths within 0.02 px with it). */
const TEXT_LAYER_FONT = 'pdf/NotoSans-Regular.ttf';

/**
 * What follows the page in view: `#page=N` in the address, and the scan hint, whose "open in Chrome" keeps the page.
 * Kept apart so the page list does not re-render.
 */
function CurrentPageExtras(p: { store: ViewerStore; scans: ScanDetector; source: string | null; onOpenInChrome: (url: string, page: number) => void }) {
  const currentPage = useViewerState(p.store, (s) => s.currentPage);
  const scanned = useScannedPage(p.scans, currentPage);
  usePageHash(currentPage);
  const { source, onOpenInChrome } = p;
  return <ScanHint shown={scanned && source !== null} onOpenInChrome={() => source !== null && onOpenInChrome(source, currentPage + 1)} />;
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

/**
 * Chromium's viewer scroll keys. (The zoom keys are commands: commands.ts.) With caret browsing on and the focus on the
 * pages (`caretKeys`), the arrows, Page Up/Down, Home and End move the text cursor instead (R93); Space still scrolls.
 */
function readerShortcuts(api: RefObject<PageListApi | null>, caretKeys: () => boolean): ShortcutDef[] {
  const on = (f: (a: PageListApi) => void) => () => {
    if (api.current) f(api.current);
  };
  const def = (enabled: () => boolean) => (id: string, keys: string[], f: (a: PageListApi) => void): ShortcutDef => ({ id, keys, run: on(f), enabled });
  const notCaret = (enabled: () => boolean) => () => enabled() && !caretKeys();
  const page = def(inPageArea);
  const pageNotCaret = def(notCaret(inPageArea));
  const vertical = def(notCaret(() => inPageArea() || onChromeButton()));
  const line = def(notCaret(() => inPageArea() || onChromeButtonNotMenu()));
  return [
    line('scroll.lineDown', ['ArrowDown'], (a) => a.scrollLines(1)),
    line('scroll.lineUp', ['ArrowUp'], (a) => a.scrollLines(-1)),
    vertical('scroll.screenDown', ['PageDown'], (a) => a.scrollScreens(1)),
    page('scroll.screenDown', ['Space'], (a) => a.scrollScreens(1)),
    vertical('scroll.screenUp', ['PageUp'], (a) => a.scrollScreens(-1)),
    page('scroll.screenUp', ['Shift+Space'], (a) => a.scrollScreens(-1)),
    vertical('scroll.start', ['Home'], (a) => a.goToStart()),
    vertical('scroll.end', ['End'], (a) => a.goToEnd()),
    pageNotCaret('scroll.left', ['ArrowLeft'], (a) => a.scrollSideways(-1)),
    pageNotCaret('scroll.right', ['ArrowRight'], (a) => a.scrollSideways(1)),
  ];
}

/** How long viewer.scrollTo waits for the page's full render before giving up. */
const SCROLL_TO_TIMEOUT_MS = 10_000;

function viewerHooks(api: RefObject<PageListApi | null>, store: ViewerStore, scans: ScanDetector, textLayers: TextLayerController): ViewerHooks {
  // A presentation whose full screen has just ended is ended before anything is read (presentation.ts).
  const read = <T,>(f: () => T): T => {
    settlePresentation();
    return f();
  };
  const a = () => read(() => api.current);
  return {
    scale: () => read(() => store.get().scale),
    setScale: (s) => a()?.zoomTo({ kind: 'scale', scale: s }),
    currentPage: () => read(() => store.get().currentPage),
    scrollTo: (i) =>
      Promise.race([
        (a()?.goToPage(i) ?? Promise.resolve()).then(() => textLayers.whenReady(i)),
        new Promise<void>((resolve) => setTimeout(resolve, SCROLL_TO_TIMEOUT_MS)),
      ]),
    snapshot: () => read(() => ({ ...store.get(), twoPage: store.get().spread === 'two-page' })),
    scrollTop: () => a()?.scrollTop() ?? 0,
    maxScrollTop: () => a()?.maxScrollTop() ?? 0,
    viewportHeight: () => a()?.viewportHeight() ?? 0,
    pageBoxes: () => a()?.pageBoxes() ?? [],
    pdfPointAt: (x, y) => a()?.pdfPointAt(x, y) ?? null,
    clientPointOf: (p) => a()?.clientPointOf(p) ?? { x: NaN, y: NaN },
    isScannedPage: (i) => scans.isScannedPage(i),
  };
}
