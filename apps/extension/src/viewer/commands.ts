// The viewer's commands: the one source for the header menus, the toolbar pill, the keyboard shortcuts and the
// shortcut sheet. Each command has a label, an icon, its keys, and what it does in this tab (ViewerContext).
import type { IconName } from '@sop/ui';
import type { SaveState } from '@sop/core';
import {
  type FindController,
  type JumpHistory,
  MAX_SCALE,
  MIN_SCALE,
  type PdfBackend,
  type RenderScheduler,
  rotate,
  type SaveController,
  type ViewerStore,
} from '@sop/viewer';
import type { PageListApi } from '@sop/viewer/react';
import type { RefObject } from 'react';
import type { ViewerParams } from '../shared/viewer-url';
import { downloadOriginal } from './actions/download';
import { palette } from '../shared/palette/state';
import type { OpenedDocument } from './open-document';
import { enterPresentation } from './presentation';
import { printDocument } from './print/print';
import type { PrintMarks } from './print/print-marks';
import { keysFor, readOverrides } from '../shortcuts/overrides';
import { isTypingTarget, type KeyCombo, type ShortcutDef } from './shortcuts';

export { buildMenus, formatCombo } from './chrome/menus';
export { downloadOriginal } from './actions/download';
export { linkForCopy } from './actions/copy-link';

export type ViewerCommandId =
  | 'file.openInChrome' | 'file.openOriginal' | 'file.download' | 'file.copyLink' | 'file.print' | 'file.saveToLibrary'
  | 'file.forget' | 'file.reportDecision' // Phase 3 (S11): save/save-commands.ts
  | 'view.fitWidth' | 'view.fitPage' | 'view.zoomIn' | 'view.zoomOut' | 'view.rotateCw' | 'view.rotateCcw'
  | 'view.twoPage' | 'view.presentation' | 'view.caretBrowsing' | 'view.toggleRail'
  | 'tools.find' | 'tools.goToPage' | 'tools.search' | 'help.shortcuts' | 'help.about'
  // Phase 2 (plan section 7). S13 runs the marks, the menu and undo; S14 the comment commands; S15 the notes ones;
  // S16 the figure and area ones. P4 adds 'claude.ask' and 'claude.explainFigure'.
  | 'marks.highlight' | 'marks.underline' | 'marks.bold' | 'marks.strike' | 'marks.comment' | 'marks.documentNote' | 'marks.menu'
  | 'edit.undo' | 'edit.redo' | 'notes.next' | 'notes.previous' | 'notes.panel' | 'figures.copyImage' | 'tools.area';

export interface ViewerCommand {
  id: ViewerCommandId;
  label: string;
  icon?: IconName;
  /** The first is the one menus and tooltips show; the shortcut sheet shows them all. */
  keys: KeyCombo[];
  run(): void;
  enabled(): boolean;
  /** Set for a command that is on or off (a menu shows a check). */
  checked?(): boolean;
  /**
   * Why it is greyed out, for a command that is off for a real reason ("400% is the largest size"): the tooltip and
   * the menu row say it after the label. Read when enabled() is false.
   */
  disabledReason?(): string | undefined;
  /**
   * False for a command whose task has not landed yet, or that this tab does not have (the marks in Incognito). It is
   * left out of the menus, the toolbar and the shortcut sheet, rather than greyed out with no reason; its keys do
   * nothing.
   */
  built: boolean;
}

/** What the commands ask of the viewer's interface (App.tsx owns the dialogs, the page box and the notices). */
export interface ViewerUi {
  /**
   * The escape hatch: this address in Chrome's own viewer (App shows Chrome's refusal, if it comes), at `page`
   * (1-based, `#page=N`) when given, so the reader keeps their place.
   */
  openInChrome(url: string, page?: number): void;
  /** Puts the focus in the toolbar's page box, with its number selected (Ctrl+G). */
  focusPageField(): void;
  showShortcuts(): void;
  showAbout(): void;
  /** Copies the PDF's link and says whether it worked. */
  copyLink(source: string): void;
  /** Shows the "Preparing to print…" dialog with how far the pages are; null closes it. `cancel` stops the work. */
  printProgress(progress: { done: number; total: number; cancel: () => void } | null): void;
  /**
   * Asks whether the marks print too (the document has some): 'with', 'without', or null when the reader cancels. Only
   * one question is open at a time.
   */
  askPrintMarks(): Promise<'with' | 'without' | null>;
  /** A short note at the bottom of the window (a snackbar), with an optional button ("Forget"). */
  showNote(text: string, action?: NoteAction): void;
}

/** The one button a note can carry. Pressing it runs `run` and closes the note. */
export interface NoteAction {
  label: string;
  run: () => void;
}

/** Built once per tab in App.tsx; later tasks fill the nullable fields. */
export interface ViewerContext {
  params: ViewerParams;
  backend: PdfBackend;
  opened: OpenedDocument;
  store: ViewerStore;
  scheduler: RenderScheduler;
  root: HTMLElement;
  /** Filled by Task 24. */
  jumps: JumpHistory | null;
  /** Filled by Task 25. */
  find: FindController | null;
  /** Ctrl+F (Task 25): opens the find bar, or selects its words when it is open. */
  openFind?: () => void;
  /** Filled by Task 30. */
  save: SaveController | null;
  /** S15: for a reading opened from its saved copy, the link it was last opened from (null while unknown, and for any other PDF). */
  originalLink?: string | null;
  /** The page list's zoom and scroll moves, while it is mounted. */
  pageList: RefObject<PageListApi | null>;
  /** The marks as the screen draws them, for Print (S17). Null in Incognito and while there are no notes. */
  printMarks?: PrintMarks | null;
  /** The caret browsing switch (R93): remembered for every PDF, the same in every tab (caret-browsing.ts). */
  caretBrowsing?: { on(): boolean; toggle(): void };
  ui: ViewerUi;
}

export type ViewerCommands = Map<ViewerCommandId, ViewerCommand>;

interface CommandSpec {
  label: string;
  icon: IconName;
  keys: KeyCombo[];
}

/** Every command, in the order of the shortcut sheet. (Dark pages were dropped: ruling R41.) Settings → Shortcuts lists them too. */
export const SPECS: [ViewerCommandId, CommandSpec][] = [
  ['file.openInChrome', { label: 'Open in Chrome’s viewer', icon: 'open_in_new', keys: [] }],
  // Phase 3 (S15): only for a reading opened from its saved copy (`?doc=`).
  ['file.openOriginal', { label: 'Open original link', icon: 'link', keys: [] }],
  // The original file, as it came: until "Download with marks" (Release 3) the label says the marks are not in it (TB4).
  ['file.download', { label: 'Download original file, without your marks', icon: 'download', keys: ['Ctrl+S'] }],
  ['file.copyLink', { label: 'Copy link', icon: 'link', keys: [] }],
  ['file.print', { label: 'Print', icon: 'print', keys: ['Ctrl+P'] }],
  ['file.saveToLibrary', { label: 'Save to library', icon: 'library_add', keys: ['Ctrl+Alt+S'] }],
  ['file.forget', { label: 'Forget this PDF', icon: 'delete_forever', keys: ['Ctrl+Shift+Delete'] }],
  ['file.reportDecision', { label: 'Report a wrong decision', icon: 'flag', keys: [] }],
  ['view.fitWidth', { label: 'Fit width', icon: 'fit_page_width', keys: ['Ctrl+0'] }],
  ['view.fitPage', { label: 'Fit page', icon: 'fit_page', keys: [] }],
  ['view.zoomIn', { label: 'Zoom in', icon: 'zoom_in', keys: ['Ctrl+=', 'Ctrl++'] }],
  ['view.zoomOut', { label: 'Zoom out', icon: 'zoom_out', keys: ['Ctrl+-'] }],
  // Task 26 (R81): the view turns, never the file; Chrome's keys.
  ['view.rotateCw', { label: 'Rotate clockwise', icon: 'rotate_right', keys: ['Ctrl+]'] }],
  ['view.rotateCcw', { label: 'Rotate counter-clockwise', icon: 'rotate_left', keys: ['Ctrl+['] }],
  ['view.twoPage', { label: 'Two-page view', icon: 'auto_stories', keys: [] }],
  ['view.presentation', { label: 'Presentation mode', icon: 'slideshow', keys: [] }],
  // R93: F7, Chrome's own key for caret browsing. The page gets it before Chrome, and taking it stops Chrome's question.
  ['view.caretBrowsing', { label: 'Caret browsing', icon: 'text_select_start', keys: ['F7'] }],
  ['view.toggleRail', { label: 'Thumbnails and outline', icon: 'photo_library', keys: ['F4'] }],
  ['tools.find', { label: 'Find', icon: 'find_in_page', keys: ['Ctrl+F'] }],
  // Not 'pageview' (a page and a magnifier), which looks like Find's icon beside it in the Tools menu.
  ['tools.goToPage', { label: 'Go to page', icon: 'move_down', keys: ['Ctrl+G'] }],
  // Phase 3 (S15): the search palette. It searches the library, so it works with or without a PDF open.
  ['tools.search', { label: 'Search your library', icon: 'search', keys: ['Ctrl+K'] }],
  ['help.shortcuts', { label: 'Keyboard shortcuts', icon: 'keyboard', keys: ['?'] }],
  ['help.about', { label: 'About sickofpdfs', icon: 'info', keys: [] }],
  // Phase 2. The mark keys act on the selected text. Alt+Shift+5 is matched by position (the number row); the letters
  // by the character they type. Ctrl+Alt+M is also found on layouts where AltGr turns it into another letter (shortcuts.ts).
  ['marks.highlight', { label: 'Highlight', icon: 'ink_highlighter', keys: ['H'] }],
  ['marks.underline', { label: 'Underline', icon: 'format_underlined', keys: ['Ctrl+U'] }],
  ['marks.bold', { label: 'Bold', icon: 'format_bold', keys: ['Ctrl+B'] }],
  ['marks.strike', { label: 'Strikethrough', icon: 'format_strikethrough', keys: ['Alt+Shift+Digit5'] }],
  ['marks.comment', { label: 'Comment', icon: 'add_comment', keys: ['Ctrl+Alt+M'] }],
  ['marks.documentNote', { label: 'Note on the whole document', icon: 'comment', keys: ['Ctrl+Alt+Shift+M'] }],
  ['marks.menu', { label: 'Mark-up menu', icon: 'more_vert', keys: ['Shift+F10', 'ContextMenu'] }],
  ['edit.undo', { label: 'Undo', icon: 'undo', keys: ['Ctrl+Z'] }],
  ['edit.redo', { label: 'Redo', icon: 'redo', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'] }],
  ['notes.next', { label: 'Next note', icon: 'keyboard_arrow_down', keys: ['Ctrl+Alt+N'] }],
  ['notes.previous', { label: 'Previous note', icon: 'keyboard_arrow_up', keys: ['Ctrl+Alt+P'] }],
  ['notes.panel', { label: 'Notes panel', icon: 'comment', keys: ['Shift+F4'] }],
  ['figures.copyImage', { label: 'Copy image', icon: 'image', keys: ['Ctrl+C'] }],
  ['tools.area', { label: 'Area note', icon: 'select', keys: [] }],
];

/** What a command does in this tab. Features (wire.ts) hand these in for the commands they own. */
export type CommandBehaviour = Pick<ViewerCommand, 'run' | 'enabled'> & Partial<Pick<ViewerCommand, 'checked' | 'disabledReason'>>;
type Behaviour = CommandBehaviour;

/** A command whose task has not landed yet: not shown anywhere (`built` false), and its keys do nothing. */
const LATER: Behaviour = { run: () => {}, enabled: () => false };

const always = () => true;

/** A scale this close to a limit is at it: zoom in (or out) has nowhere to go. */
const LIMIT_EPSILON = 1e-3;

function assemble(behaviours: Partial<Record<ViewerCommandId, Behaviour>>): ViewerCommands {
  const overrides = readOverrides();
  return new Map(
    SPECS.map(([id, spec]): [ViewerCommandId, ViewerCommand] => {
      const behaviour = behaviours[id];
      return [id, { id, ...spec, keys: keysFor(id, spec.keys, overrides), ...(behaviour ?? LATER), built: behaviour !== undefined }]; // S14: the owner's own keys
    }),
  );
}

/** A command that is off for as long as `reason` says (the PDF is still opening, or did not open). */
function offBecause(reason: string): Behaviour {
  return { run: () => {}, enabled: () => false, disabledReason: () => reason };
}

/** The reason a command with no web address to use is off. */
const NO_ADDRESS = 'this PDF has no web address';

/** The link "Copy link" copies: the address the PDF was opened from (for a saved copy, the link it came from). A file picked from disk has none. */
function linkOf(ctx: Pick<ViewerContext, 'params' | 'opened' | 'originalLink'>): string | null {
  return ctx.opened.loaded.sourceUrl === null ? (ctx.originalLink ?? null) : (ctx.params.source ?? ctx.opened.loaded.sourceUrl);
}

/**
 * Fit page, as Chromium's viewer does it: the page in view is sized to fit the window and lined up with its top, so the
 * whole page shows (and Page Down then moves exactly one page).
 */
function fitPage(pages: PageListApi | null, store: ViewerStore): void {
  if (pages === null) return;
  const page = store.get().currentPage;
  pages.zoomTo({ kind: 'fit-page' });
  void pages.goToPage(page);
}

/** The save states the chip and Ctrl+Alt+S can save from: the PDF is not in the library, and not in Incognito. */
const SAVABLE = new Set(['unsure', 'not-learning', 'memory-only', 'asking']);

/** Why Save to library is off in each state it cannot save from. */
const NOT_SAVABLE: Partial<Record<SaveState['kind'], string>> = {
  checking: 'still checking this PDF',
  saved: 'it’s in your library already',
  incognito: 'nothing is saved in an Incognito window',
};

/** Ctrl+Alt+S and File → Save to library (Task 30). A failed save is told by the App's note, so it is not rethrown. */
function saveToLibrary(save: SaveController | null): Behaviour {
  return {
    run: () => void save?.requestSave().catch(() => {}),
    enabled: () => save !== null && SAVABLE.has(save.state.kind),
    disabledReason: () => (save === null ? 'the PDF is still opening' : NOT_SAVABLE[save.state.kind]),
  };
}

/**
 * Fit width: true fit width (Ctrl+0), or the capped one a document opens at (ruling R61) while the cap is not what
 * sets the size (a narrow window, where it does fit the width). At the cap it reads as its percentage instead (100%).
 */
function isFitWidth(store: ViewerStore): boolean {
  const { zoom, scale } = store.get();
  return zoom.kind === 'fit-width' && (zoom.max === undefined || scale < zoom.max - LIMIT_EPSILON);
}

/**
 * Presentation mode shows one page on black and nothing else (Task 26): every other command is off until it ends, so
 * no key opens a panel, a bar or a dialog behind it, or zooms its page away from the screen's size.
 */
function offWhilePresenting(store: ViewerStore, behaviours: Partial<Record<ViewerCommandId, Behaviour>>): Partial<Record<ViewerCommandId, Behaviour>> {
  const presenting = () => store.get().presenting !== null;
  return Object.fromEntries(
    Object.entries(behaviours).map(([id, b]) =>
      id === 'view.presentation' || b === undefined ? [id, b] : [id, { ...b, enabled: () => !presenting() && b.enabled() }],
    ),
  );
}

/** Two-page view (Task 26): pages in pairs, 1–2, 3–4, … A per-tab view setting, like rotation: never saved. */
function toggleTwoPage(store: ViewerStore): void {
  store.set({ spread: store.get().spread === 'two-page' ? 'none' : 'two-page' });
}

/** Caret browsing (R93): a switch with a check mark, for every PDF and every tab. */
function caretBrowsingCommand(c: NonNullable<ViewerContext['caretBrowsing']>): Behaviour {
  return { run: () => c.toggle(), enabled: always, checked: () => c.on() };
}

/**
 * The commands for an open document. `extra` is what the marks and the registered features (annotations/wire.ts) do
 * for the commands they own.
 */
export function createCommands(ctx: ViewerContext, extra: Partial<Record<ViewerCommandId, Behaviour>> = {}): ViewerCommands {
  const pages = () => ctx.pageList.current;
  const source = ctx.params.source;
  const link = linkOf(ctx);
  const scale = () => ctx.store.get().scale;
  const turn = (dir: 1 | -1) => ctx.store.set({ viewRotation: rotate(ctx.store.get().viewRotation, dir) });
  return assemble(offWhilePresenting(ctx.store, {
    ...extra,
    // The page in view goes with it (#page=N), so Chrome's viewer opens where the reader was.
    'file.openInChrome': { run: () => source !== null && ctx.ui.openInChrome(source, ctx.store.get().currentPage + 1), enabled: () => source !== null, disabledReason: () => NO_ADDRESS },
    // A reading opened from its saved copy: its original link, in a new tab. Left out of the menu for any other PDF.
    ...(ctx.params.doc
      ? {
          'file.openOriginal': {
            run: () => {
              if (ctx.originalLink) void chrome.tabs.create({ url: ctx.originalLink });
            },
            enabled: () => !!ctx.originalLink,
            disabledReason: () => 'this PDF has no saved link',
          } satisfies Behaviour,
        }
      : {}),
    'file.download': { run: () => downloadOriginal(ctx.opened.loaded.blob, ctx.opened.loaded.displayName), enabled: always },
    'file.copyLink': { run: () => link !== null && ctx.ui.copyLink(link), enabled: () => link !== null, disabledReason: () => NO_ADDRESS },
    'file.saveToLibrary': saveToLibrary(ctx.save),
    'file.print': { run: () => void printDocument(ctx), enabled: always },
    'view.fitWidth': { run: () => pages()?.zoomTo({ kind: 'fit-width' }), enabled: always, checked: () => isFitWidth(ctx.store) },
    'view.fitPage': { run: () => fitPage(pages(), ctx.store), enabled: always, checked: () => ctx.store.get().zoom.kind === 'fit-page' },
    'view.zoomIn': { run: () => pages()?.zoomStep(1), enabled: () => scale() < MAX_SCALE - LIMIT_EPSILON, disabledReason: () => '400% is the largest size' },
    'view.zoomOut': { run: () => pages()?.zoomStep(-1), enabled: () => scale() > MIN_SCALE + LIMIT_EPSILON, disabledReason: () => '25% is the smallest size' },
    // R81: a view setting for this tab only (the file never changes, and the PDF reopens upright); all pages turn.
    'view.rotateCw': { run: () => turn(1), enabled: always },
    'view.rotateCcw': { run: () => turn(-1), enabled: always },
    'view.twoPage': { run: () => toggleTwoPage(ctx.store), enabled: always, checked: () => ctx.store.get().spread === 'two-page' },
    'view.presentation': { run: () => void enterPresentation(ctx).catch(() => {}), enabled: () => ctx.store.get().presenting === null },
    ...(ctx.caretBrowsing !== undefined ? { 'view.caretBrowsing': caretBrowsingCommand(ctx.caretBrowsing) } : {}),
    'view.toggleRail': { run: () => ctx.store.set({ railOpen: !ctx.store.get().railOpen }), enabled: always, checked: () => ctx.store.get().railOpen },
    'tools.find': { run: () => ctx.openFind?.(), enabled: () => ctx.openFind !== undefined },
    'tools.goToPage': { run: () => ctx.ui.focusPageField(), enabled: always },
    'tools.search': { run: () => palette.toggle(), enabled: always },
    'help.shortcuts': { run: () => ctx.ui.showShortcuts(), enabled: always },
    'help.about': { run: () => ctx.ui.showAbout(), enabled: always },
  }));
}

/** The commands that need an open document: while there is none, they are greyed out and say why. */
const DOCUMENT_COMMANDS: ViewerCommandId[] = [
  'file.download', 'file.print', 'file.saveToLibrary', 'view.fitWidth', 'view.fitPage', 'view.zoomIn', 'view.zoomOut',
  'view.rotateCw', 'view.rotateCcw', 'view.twoPage', 'view.presentation', 'view.caretBrowsing', 'view.toggleRail', 'tools.find',
  'tools.goToPage',
];

/**
 * The commands while no document is open (loading, an error card, the large-file note): the escape hatch, the link
 * and Help work; the reading commands are greyed out with `reason` ("the PDF is still opening"); the marks are not
 * shown.
 */
export function createIdleCommands(o: { source: string | null; canOpenInChrome: boolean; ui: ViewerUi; reason: string }): ViewerCommands {
  const { source, ui } = o;
  const off = offBecause(o.reason);
  return assemble({
    ...Object.fromEntries(DOCUMENT_COMMANDS.map((id) => [id, off])),
    'file.openInChrome': {
      run: () => source !== null && ui.openInChrome(source),
      enabled: () => source !== null && o.canOpenInChrome,
      disabledReason: () => (source === null ? NO_ADDRESS : 'Chrome can’t open this file from here'),
    },
    'file.copyLink': { run: () => source !== null && ui.copyLink(source), enabled: () => source !== null, disabledReason: () => NO_ADDRESS },
    'tools.search': { run: () => palette.toggle(), enabled: always },
    'help.shortcuts': { run: () => ui.showShortcuts(), enabled: always },
    'help.about': { run: () => ui.showAbout(), enabled: always },
  });
}

/**
 * Extra keys that are not shown: Ctrl+Shift+Minus types "_" on a US keyboard, and Chrome zooms the browser out on it,
 * so it zooms the pages out instead.
 */
const HIDDEN_KEYS: Partial<Record<ViewerCommandId, KeyCombo[]>> = { 'view.zoomOut': ['Ctrl+_'] };

/**
 * Commands whose Ctrl keys are editing keys: they act only when they can (text is selected, there is a figure to copy),
 * and otherwise the key does what it does anyway. In a text field (the note box, the page box) they always type: Ctrl+B
 * and Ctrl+Z belong to the note box there, and Ctrl+C copies its text (plan section 7). Ctrl+Shift+Delete (Forget this
 * PDF) too: never while a note is being typed, and Chrome's own "Clear browsing data" when the PDF is not saved.
 */
const EDITING_KEYS = new Set<ViewerCommandId>(['marks.underline', 'marks.bold', 'figures.copyImage', 'edit.undo', 'edit.redo', 'file.forget']);

/**
 * Keys the viewer always takes, with nothing selected and in a text field too, because the browser's own action is
 * never wanted here. Ctrl+U would open the viewer page's source in a new tab (ruling: Ctrl+U with nothing selected does
 * nothing). In a text field it does nothing either: the note box has no underline.
 */
const NEVER_THE_BROWSERS: Partial<Record<ViewerCommandId, KeyCombo[]>> = { 'marks.underline': ['Ctrl+U'] };

/**
 * Commands whose Ctrl+Alt letter also matches by the physical key (shortcuts.ts): on a German keyboard Ctrl+Alt+M types
 * "µ" and must still comment (plan section 7). Every other letter is matched by the character it types.
 */
const BY_PHYSICAL_KEY = new Set<ViewerCommandId>(['marks.comment', 'marks.documentNote']);

/**
 * Single keys that do nothing in a text field (single keys never fire while typing), not even the browser's own action:
 * F7 there would ask to turn on Chrome's caret browsing over the viewer's own.
 */
const SWALLOWED_WHILE_TYPING = new Set<ViewerCommandId>(['view.caretBrowsing']);

/** The key was pressed in a text field (the note box, the page box). */
function inTextField(e: KeyboardEvent): boolean {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  return isTypingTarget(path[0] ?? e.target);
}

/**
 * A Ctrl combo without Alt is the viewer's even while its command is greyed out: it does nothing rather than let
 * Chrome print the viewer page, save it, open its find bar or zoom the browser. Single keys and Ctrl+Alt combos (F4,
 * ?, Ctrl+Alt+S) are left to the browser while their command is greyed out, and so are the editing keys above.
 */
function alwaysOurs(id: ViewerCommandId, combo: KeyCombo): boolean {
  return combo.startsWith('Ctrl+') && !combo.includes('Alt+') && !EDITING_KEYS.has(id);
}

/** While the search palette is open its keys are its own: no command's key runs behind it, except Ctrl+K, which closes it (S15). */
const keysFree = (id: ViewerCommandId): boolean => id === 'tools.search' || !palette.isOpen();

/** The shortcuts for installShortcuts: every command's keys, in command order. */
export function commandShortcuts(cmds: ViewerCommands): ShortcutDef[] {
  const defs: ShortcutDef[] = [];
  const rebound = readOverrides();
  for (const c of cmds.values()) {
    const taken = NEVER_THE_BROWSERS[c.id] ?? [];
    const keys = [...c.keys, ...(rebound[c.id] !== undefined ? [] : (HIDDEN_KEYS[c.id] ?? []))].filter((k) => !taken.includes(k));
    const ours = keys.filter((k) => alwaysOurs(c.id, k));
    const others = keys.filter((k) => !alwaysOurs(c.id, k));
    const typing = EDITING_KEYS.has(c.id) ? { whileTyping: 'yield' as const } : SWALLOWED_WHILE_TYPING.has(c.id) ? { whileTyping: 'swallow' as const } : {};
    // Still taken from Chrome when the owner gave the command another key (S14), but then it does nothing.
    if (taken.length > 0) defs.push({ id: c.id, keys: taken, run: (e) => c.keys.some((k) => taken.includes(k)) && !inTextField(e) && keysFree(c.id) && c.enabled() && c.run() });
    if (ours.length > 0) defs.push({ id: c.id, keys: ours, run: () => keysFree(c.id) && c.enabled() && c.run() });
    const physical = BY_PHYSICAL_KEY.has(c.id) ? { byPhysicalKey: true } : {};
    if (others.length > 0) defs.push({ id: c.id, keys: others, run: () => c.run(), enabled: () => keysFree(c.id) && c.enabled(), ...typing, ...physical });
  }
  return defs;
}
