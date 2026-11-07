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
  withOcr,
  useViewerState,
  type ViewerSnapshot,
  type ViewerStore,
  type ZoomMode,
} from '@sop/viewer';
import {
  MarkLayer,
  type PageLayerContext,
  PageList,
  type PageListApi,
  TextLayer,
  TextLayerController,
  WordStartsController,
  WordStartsLayer,
  ScanInkPages,
  ScanInkWatch,
} from '@sop/viewer/react';
import { ocrToPageGlyphs } from '@sop/core';
import { memo, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sendRuntimeMessage } from '../shared/send-message';
import { parseViewerUrl, type ViewerParams } from '../shared/viewer-url';
import { copyLink, linkForCopy } from './actions/copy-link';
import { ToolbarExtrasContext, type ToolbarExtras } from './chrome/toolbar-extras';
import { useMenusHidden } from './menus-hidden';
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
import { NotesMovedBanner, useNotesMoved } from './about/NotesMovedBanner';
import { createScanFigures } from './ocr/layout-wire';
import { OcrChip } from './ocr/OcrChip';
import { findNoteSource } from './ocr/use-ocr';
import { createViewerOcr, type ViewerOcr } from './ocr/wire';
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
import { useNotesPanelOpen } from './notes-panel/panel-state';
import { type StartOverOffer, useReadingHistory } from './history/use-reading-history';
import { hitFlashFeature } from './hit-flash';
import { claudeUiFeature } from './claude/ui/feature';
import { claudeEntryFeature } from './claude/entry';
import { createHitJumper, type HitJumper, useOpenTarget } from './jump-to-hit';
import { openSavedCopy, savedCopyName } from './open-saved';
import { useOriginalLink } from './original-link';
import { ViewerPalette } from './palette-host';
import { aboutCommands } from './about/about-commands';
import { ViewerAbout } from './about/ViewerAbout';
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
import { type PrintAsk, type PrintChoice, PrintDialog } from './print/PrintDialog';
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
import { exportPdfFeature } from './export/feature';
import { importPdfFeature } from './import/feature';
import { LoadErrorCard } from './ui/LoadErrorCard';
import { LocalFileCard } from './ui/LocalFileCard';
import { PasswordDialog } from './ui/PasswordDialog';
import { ScanHint } from './ui/ScanHint';
import { useStore } from './use-store';
import { chooseWordStarts, noteScannedPageOnce, useWordStarts, useWordStartsStrength, WORD_STARTS_LOOK, wordStartsLevel, wordStartsStrength, wordStartsSwitch } from './word-starts';

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
// Phase 8 (slice 8.3): File → Download with notes, and the toolbar's download menu.
registerViewerFeature(exportPdfFeature);
registerViewerFeature(importPdfFeature);
// Phase 3 (S15): the words a search jump landed on, picked out for a moment.
registerViewerFeature(hitFlashFeature);
// Phase 4 (slice F): Claude in the thread: its chips, the @Claude suggestion, the confirm dialog and the Ask Claude items.
registerViewerFeature(claudeUiFeature);
// Phase 4 (slice D): @Claude's turn runner for the open PDF (the entry the Claude items call).
registerViewerFeature(claudeEntryFeature);

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
  const [printAsk, setPrintAsk] = useState<{ ask: PrintAsk; answer(this: void, choice: PrintChoice | null): void } | null>(null);
  const ui = useMemo<ViewerUi>(
    () => ({
      openInChrome: escape,
      focusPageField: () => {
        pageField.current?.focus();
        pageField.current?.select();
      },
      showShortcuts: () => setDialog('shortcuts'),
      showAbout: () => setDialog('about'),
      copyLink: (link) => void copyLink(link).then((ok) => setNote({ text: ok ? 'Link copied' : `Couldn’t copy the link. Copy it by hand: ${linkForCopy(link)}` })),
      printProgress: setPrinting,
      askPrint: (ask) =>
        new Promise((resolve) =>
          setPrintAsk({
            ask,
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
  useUndoneNote(save, ui);
  const form = useFormBounce({ opened, save, source, backend });
  // R103: an earlier version of a saved web page whose notes moved to the newer one says so.
  const notesMoved = useNotesMoved(save);
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
  const wordStartsOn = useWordStarts(); // View → Bold word starts ticks its choice
  const wordStartsStrengthNow = useWordStartsStrength();
  const presenting = useViewerState(live?.store ?? IDLE_STORE, (s) => s.presenting !== null); // R95: the not-sure count pauses
  const menus = useMemo(() => buildMenus(commands), [commands, viewVersion, saveKind, caretOn, wordStartsOn, wordStartsStrengthNow]); // eslint-disable-line react-hooks/exhaustive-deps -- viewVersion, saveKind, caretOn, wordStartsOn and wordStartsStrengthNow are the triggers
  // TB6: while the notes panel is open the page column ends before it, so the panel never covers a page (App.module.css).
  const notesPanelOpen = useNotesPanelOpen();

  // "Hide the menus": the header is folded away, so the status chip and "Back to page" move into the toolbar pill.
  const menusHidden = useMenusHidden();
  const copyLinkCmd = commands.get('file.copyLink');
  // Phase 7.5: while a scan's text is being read, a quiet chip says so, before the status chip (in the pill too).
  const liveOcr = live?.ocr ?? null;
  const toolbarExtras = useMemo<ToolbarExtras>(
    () => ({
      chip: (
        <>
          <OcrChip ocr={liveOcr} compact />
          {save !== null && <StatusChip save={save} returnFocus={focusPages} ui={ui} compact />}
        </>
      ),
      moreRows:
        back === null
          ? []
          : [{ kind: 'item', id: 'back', label: 'Back to page', icon: 'arrow_back', onSelect: () => void goBackToPage(back) }],
    }),
    [save, focusPages, ui, back, liveOcr],
  );

  return (
    <ToolbarExtrasContext.Provider value={toolbarExtras}>
    <div ref={root} className={styles.app} data-menus-hidden={menusHidden ? '' : undefined}>
      <Header
        menusHidden={menusHidden}
        copyLink={
          copyLinkCmd === undefined || !copyLinkCmd.built
            ? null
            : { run: () => copyLinkCmd.run(), enabled: copyLinkCmd.enabled(), reason: copyLinkCmd.disabledReason?.() }
        }
        name={name}
        hint={title === null ? name : title.full === title.fileName ? title.fileName : `${title.full}\n${title.fileName}`}
        onBack={back === null ? null : () => void goBackToPage(back)}
        menus={menus}
        // The error and stopped cards carry their own "Open in Chrome's viewer"; one is enough on screen.
        onOpenInChrome={!canEscape || view.kind === 'error' || view.kind === 'stopped' ? null : () => escape(source, (live?.store.get().currentPage ?? 0) + 1)}
        chromeRefused={chromeRefused}
        status={
          <>
            {!menusHidden && <OcrChip ocr={liveOcr} />}
            {save !== null && <StatusChip save={save} returnFocus={focusPages} ui={ui} />}
          </>
        }
        returnFocus={focusPages}
      />
      {/* Drawn at the bottom left, but early in the Tab order (TB5): its button ("Start from page 1", "Undo") is reached
          right after the header, before the toolbar and every link in the PDF. */}
      <Snackbar note={note} />
      {/* R95: drawn under the toolbar, above the pages it pushes down. Outside the header, which can be folded away. */}
      {save !== null && view.kind === 'ready' && form.notice === null && <NotSureBanner save={save} ui={ui} presenting={presenting} />}
      <div className={styles.content} data-notes-panel-open={notesPanelOpen && view.kind === 'ready' ? '' : undefined}>
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
        {view.kind === 'ready' && form.notice === null && notesMoved.newer !== null && <NotesMovedBanner newer={notesMoved.newer} onDismiss={notesMoved.dismiss} />}
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
      {printAsk !== null && <PrintDialog ask={printAsk.ask} onAnswer={printAsk.answer} />}
      <SaveDialogs save={save} ui={ui} />
      {printing !== null && <PrintProgressDialog done={printing.done} total={printing.total} onCancel={printing.cancel} />}
    </div>
    </ToolbarExtrasContext.Provider>
  );
}

/** Said when the status chip's Undo (R62) took the first mark, and the save it started, back. */
const UNDONE_NOTE = 'Mark removed. This PDF isn’t in your library.';

/**
 * The chip's Undo leaves no other sign than the chip going back to "Not sure", so a short note says what it did (TB4
 * fix round). An undoable save only ever goes back to "not sure" through that Undo.
 */
function useUndoneNote(save: SaveControllerImpl | null, ui: Pick<ViewerUi, 'showNote'>): void {
  useEffect(() => {
    if (save === null) return;
    let was = save.state;
    return save.subscribe(() => {
      const now = save.state;
      if (was.kind === 'saved' && was.undoable && now.kind === 'unsure') ui.showNote(UNDONE_NOTE);
      was = now;
    });
  }, [save, ui]);
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
  /** Phase 7.5: the reading of the document's scanned pages, for the header's chip. */
  ocr: ViewerOcr;
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
      railOpen: railStartsOpen(),
      ...resume,
    }),
  );
  const [scheduler] = useState(
    () => new RenderScheduler(backend, doc.open.doc, { concurrency: ENGINE_WORKERS, previewWidthPx: 160, previewCache: 300 }),
  );
  const [scans] = useState(() => new ScanDetector(backend, doc.open.doc, doc.open.pages));
  // The page text everything reads (the text layer, marks, find, Claude): one glyph cache for the document. Phase 7: a scanned
  // page answers with its recognised text (withOcr), read in this tab or in the background (ocr/wire.ts).
  const [pdfiumText] = useState(() => createPageTextProvider(backend, doc.open.doc));
  const [ocr] = useState(() => createViewerOcr({ backend, opened: doc, base: pdfiumText }));
  // A scan's words read ahead from the page's own ink (R106): their char boxes follow the real letters, and bold on them
  // is ready before the key press.
  const [scanInk] = useState(
    () =>
      new ScanInkPages(
        {
          rawGlyphs: async (i) => {
            const r = await ocr.lookup.page(i);
            return r === null ? null : ocrToPageGlyphs(r, { rotation: ocr.lookup.rotation(i) });
          },
        },
        doc.open.pages,
      ),
  );
  useEffect(() => () => scanInk.dispose(), [scanInk]);
  const [pageText] = useState(() => withOcr(pdfiumText, ocr.lookup, { cuts: (i) => scanInk.cuts(i) }));
  useEffect(() => ocr.attach(save), [ocr, save]);
  useEffect(() => () => ocr.dispose(), [ocr]);
  const [scanFigures] = useState(() => createScanFigures({ backend, opened: doc, ocr }));
  useEffect(() => () => scanFigures.dispose(), [scanFigures]);
  useOcrHints(ocr, store);
  // The scan hint (reading is off: "open it in Chrome's viewer") and Find's scan note step aside while the scan is being read;
  // Find says which pages are still to read instead (Phase 7.5).
  const ocrScans = useMemo(() => ({ isScannedPage: (i: number) => scans.isScannedPage(i).then((scan) => scan && !ocr.reading()) }), [scans, ocr]);
  const findReading = useMemo(() => findNoteSource(ocr), [ocr]);
  // Bold word starts draw over the PDF's own glyphs, so they read PDFium's text, never the recognised text.
  const wordStarts = useWordStartsController(doc, pdfiumText, scans, scheduler, ui);
  // With word starts on, a bold mark takes their weight when it is heavier (Strong), so a word the owner made bold reads
  // as bold all through instead of heavier at its start (R90).
  const wordStartsOn = useWordStarts();
  const wordStartsLook = WORD_STARTS_LOOK[useWordStartsStrength()];
  const markBoldLook = wordStartsOn && (wordStartsLook.gain > 1 || wordStartsLook.boost > 0) ? wordStartsLook : undefined;
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
  const find = useReaderFind({ backend, doc, store, api, pageText, textLayers, jumps: nav.jumps, root: rootRef, scans: ocrScans, reading: findReading });
  // A page whose recognised text arrives (or goes) is read again by the text layer and Find.
  const findController = find.controller;
  useEffect(
    () =>
      ocr.onPageText((i) => {
        textLayers.refreshPage(i);
        findController?.refreshPage?.(i);
        scanInk.pageTextChanged(i);
      }),
    [ocr, textLayers, findController, scanInk],
  );
  // The words being selected on a scan are read ahead first: a bold mark on them is likely next.
  // Once the pointer is up (or the keys made the selection), they are grown at once.
  useEffect(() => {
    const ranges = () => textLayers.selectionRanges().map((r) => ({ pageIndex: r.pageIndex, start: r.start, end: r.end }));
    let down = false;
    const onSelect = () => scanInk.prefer(ranges(), !down);
    const onDown = () => (down = true);
    const onUp = () => {
      down = false;
      // after the browser has settled the selection
      setTimeout(() => scanInk.prefer(ranges(), true), 0);
    };
    document.addEventListener('selectionchange', onSelect);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    return () => {
      document.removeEventListener('selectionchange', onSelect);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
    };
  }, [scanInk, textLayers]);
  // A scan's char boxes, once they follow its letters' ink, are read again by the text layer and Find.
  useEffect(
    () =>
      scanInk.onRefined((i) => {
        textLayers.refreshPage(i);
        findController?.refreshPage?.(i);
      }),
    [scanInk, textLayers, findController],
  );
  // The document's notes: marks, comments and drafts (Phase 2). Null in Incognito, which has none.
  const notes = useNotes(doc, pageText, store, api, textLayers, save, nav.jumps, ui, scanFigures);
  // Reading time, the last spot and the pages visited (kept once the PDF is saved), and the return to the last spot.
  // TB5: "Start from page 1" in the File menu as well as on the note, while the resume stands.
  const [startOver, setStartOver] = useState<StartOverOffer | null>(null);
  useReadingHistory({ doc, params, view: store, pageList: api, save, ui, restarted: resume !== undefined, onStartOver: setStartOver });
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
      wordStarts: { on: wordStartsSwitch.get, toggle: () => void wordStartsSwitch.toggle(), level: wordStartsLevel, choose: chooseWordStarts },
      ui,
    };
    return createCommands(ctx, {
      ...notes?.behaviours(),
      ...saveDecisionCommands(save),
      ...aboutCommands(),
      ...(startOver !== null ? { 'file.startOver': { run: startOver.run, enabled: () => true } } : {}),
    });
  }, [params, doc, store, scheduler, rootRef, ui, save, nav.jumps, find.controller, find.open, notes, pageText, originalLink, startOver]);
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
    onChrome({ commands, store, jumper, ocr });
    return () => onChrome(null);
  }, [commands, store, jumper, ocr, onChrome]);
  useEffect(() => installShortcuts(readerShortcuts(api, () => textLayers.caret.takesKeys())), [textLayers]);
  useEffect(() => () => textLayers.dispose(), [textLayers]);
  useEffect(
    () =>
      publishRuntime({
        viewer: viewerHooks(api, store, scans, textLayers),
        selectionRanges: () => textLayers.selectionRanges(),
        ocr: { progress: () => ocr.progress(), recognised: () => ocr.recognised(), text: (i: number) => pageText.text(i), chars: (i: number) => pageText.rawText(i), source: (i: number) => pageText.source(i) },
        glyphCenter: (pageIndex, charIndex) => textLayers.glyphCenter(pageIndex, charIndex),
        caret: () => ({ on: textLayers.caret.enabled, position: textLayers.caret.position() }),
      }),
    [store, scans, textLayers, ocr, pageText],
  );
  // Each page, bottom to top: the bold word starts (R90), its marks (and bold) and the features' page layers (Phase 2),
  // find's highlights (Task 25), the selection and the text layer, then the links (Task 24).
  const findLayer = find.pageLayer;
  const linksFor = nav.renderPage;
  const bold = useMemo(() => ({ backend, doc: doc.open.doc, text: pageText, scanInk }), [doc, pageText, scanInk]);
  const renderPage = useCallback(
    (box: PageBox, ctx: PageLayerContext) => (
      <>
        <WordStartsLayer controller={wordStarts} box={box} ctx={ctx} page={doc.open.pages[box.index]} />
        <ScanInkWatch pages={scanInk} index={box.index} ctx={ctx} />
        {notes !== null && (
          <MarkLayer
            source={notes.layer}
            box={box}
            ctx={ctx}
            page={doc.open.pages[box.index]}
            bold={bold}
            {...(markBoldLook !== undefined ? { boldLook: markBoldLook } : {})}
          />
        )}
        {notes !== null && viewerFeatures().map((f) => f.PageLayer && <f.PageLayer key={f.id} host={notes.host} box={box} ctx={ctx} />)}
        {findLayer(box, ctx)}
        <TextLayer controller={textLayers} box={box} ctx={ctx} />
        {linksFor(box)}
      </>
    ),
    [textLayers, findLayer, linksFor, notes, doc, bold, wordStarts, markBoldLook, scanInk],
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
  const [reserveAtOpen] = useState(() =>
    viewerFeatures()
      .map((f) => f.reserveAtOpen?.(doc) ?? null)
      .reduce<{ px: number; maxShift?: number } | null>((a, b) => (b !== null && b.px > (a?.px ?? 0) ? b : a), null),
  );
  // The rail's pill sits over the rail while it is open; with it closed, a two-page spread keeps clear of it.
  const railOpen = useViewerState(store, (s) => s.railOpen);
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
        end={<><CurrentPageExtras store={store} scans={ocrScans} why={() => (ocr.status().phase === 'error' ? 'failed' : 'off')} source={doc.loaded.sourceUrl} onOpenInChrome={(url, page) => ui.openInChrome(url, page)} />{!compact && <AreaToolButton commands={commands} />}<CommentButton /></>}
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
        <PageList backend={backend} doc={doc} store={store} scheduler={scheduler} apiRef={api} renderPage={renderPage} onError={onDrawError} initialReserveRight={reserveAtOpen?.px ?? 0} initialReserveOptions={reserveAtOpen ?? undefined} spreadSideClearance={railOpen ? 0 : SPREAD_SIDE_CLEARANCE} />
      </NavRail>
      {find.view}
      {notes !== null && viewerFeatures().map((f) => f.View && <f.View key={f.id} host={notes.host} />)}
      {notes !== null && <MarkupMenu input={notes.input} commands={commands} />}
      <ViewerAbout doc={doc} save={save} session={notes?.host.session ?? null} ui={ui} />
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
  scanFigures: ReturnType<typeof createScanFigures>,
): Notes | null {
  const [notes, setNotes] = useState<Notes | null>(null);
  useEffect(() => {
    if (save === null) return;
    const made = createNotes({ backend, opened: doc, pageText, view, pageList, jumps, textSelection: textLayers.textSelection, showNote: (text, action) => ui.showNote(text, action), save, scanFigures: (i) => scanFigures.figures(i), onScanFiguresNamed: (cb) => scanFigures.onNamed(cb) });
    setNotes(made);
    publishRuntime({ annotations: made?.host.session ?? null });
    return () => {
      made?.dispose();
      setNotes(null);
      publishRuntime({ annotations: null });
    };
  }, [doc, pageText, view, pageList, textLayers, save, jumps, ui, scanFigures]);
  return notes;
}

/**
 * The document's bold word starts (R90), made once with the document and following the switch in every tab. A page in
 * view with nothing to draw is checked for being a scan (no text and mostly a picture, or text with no glyphs to draw
 * over a picture, as a scan's OCR layer is); the first such page in this tab gets R90's quiet note.
 */
function useWordStartsController(
  doc: OpenedDocument,
  pageText: ReturnType<typeof createPageTextProvider>,
  scans: ScanDetector,
  scheduler: RenderScheduler,
  ui: ViewerUi,
): WordStartsController {
  const [controller] = useState(() => {
    const made: WordStartsController = new WordStartsController({
      backend,
      doc: doc.open.doc,
      text: pageText,
      pageCount: doc.open.pageCount,
      renderIdle: () => scheduler.isIdle(),
      onNothingToDraw: (pageIndex, hasText) => {
        (hasText ? scans.isImagePage(pageIndex) : scans.isScannedPage(pageIndex)).then(
          (scan) => scan && made.enabled && noteScannedPageOnce((text) => ui.showNote(text)),
          () => {},
        );
      },
    });
    return made;
  });
  useEffect(() => {
    controller.start();
    controller.setEnabled(wordStartsSwitch.get());
    const off = wordStartsSwitch.subscribe(() => controller.setEnabled(wordStartsSwitch.get()));
    const gain = () => controller.setLook(WORD_STARTS_LOOK[wordStartsStrength.get()]);
    gain();
    const offGain = wordStartsStrength.subscribe(gain);
    return () => {
      off();
      offGain();
      controller.dispose();
    };
  }, [controller]);
  return controller;
}

/**
 * Two-page view with the rail closed: room kept clear at each side of a fitted spread (the rail's 56 px pill at the
 * bottom left, mirrored on the right), so the spread is centred in the reading area and the pill never sits on a page.
 */
const SPREAD_SIDE_CLEARANCE = 56;

/** The text layer's font: the engine's bundled Noto Sans (the spike measured canvas and DOM widths within 0.02 px with it). */
const TEXT_LAYER_FONT = 'pdf/NotoSans-Regular.ttf';

/**
 * What follows the page in view: `#page=N` in the address, and the scan hint, whose "open in Chrome" keeps the page.
 * Kept apart so the page list does not re-render.
 */
function CurrentPageExtras(p: { store: ViewerStore; scans: Pick<ScanDetector, 'isScannedPage'>; why: () => 'off' | 'failed'; source: string | null; onOpenInChrome: (url: string, page: number) => void }) {
  const currentPage = useViewerState(p.store, (s) => s.currentPage);
  const scanned = useScannedPage(p.scans, currentPage);
  usePageHash(currentPage);
  const { source, onOpenInChrome } = p;
  return <ScanHint shown={scanned && source !== null} why={p.why()} onOpenInChrome={() => source !== null && onOpenInChrome(source, currentPage + 1)} />;
}

/** How long the reader stays on a page before it is checked for being a scan (the check shares the engine). */
const SCAN_CHECK_DELAY_MS = 400;

/** Whether page `index` is a scan, checked once the reader has stayed on it for a moment. */
function useScannedPage(scans: Pick<ScanDetector, 'isScannedPage'>, index: number): boolean {
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

/**
 * Tells the scan reader which pages are on screen (the page in view and the next one) and which way the reader is going, so they
 * are read first. Follows the view store without re-rendering the Reader.
 */
function useOcrHints(ocr: ViewerOcr, store: ViewerStore): void {
  useEffect(() => {
    let last = store.get().currentPage;
    let direction: 1 | -1 = 1;
    const send = () => ocr.hint(direction === 1 ? [last, last + 1, last - 1] : [last, last - 1, last + 1], direction);
    send();
    return store.subscribe(() => {
      const now = store.get().currentPage;
      if (now === last) return;
      direction = now > last ? 1 : -1;
      last = now;
      send();
    });
  }, [ocr, store]);
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
