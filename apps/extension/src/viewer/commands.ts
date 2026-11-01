// The viewer's commands: the one source for the header menus, the toolbar pill, the keyboard shortcuts and the
// shortcut sheet. Each command has a label, an icon, its keys, and what it does in this tab (ViewerContext).
import type { IconName } from '@sop/ui';
import {
  type FindController,
  type JumpHistory,
  MAX_SCALE,
  MIN_SCALE,
  type PdfBackend,
  type RenderScheduler,
  type SaveController,
  type ViewerStore,
} from '@sop/viewer';
import type { PageListApi } from '@sop/viewer/react';
import type { RefObject } from 'react';
import type { ViewerParams } from '../shared/viewer-url';
import { downloadOriginal } from './actions/download';
import type { OpenedDocument } from './open-document';
import { printDocument } from './print/print';
import type { KeyCombo, ShortcutDef } from './shortcuts';

export { buildMenus, formatCombo } from './chrome/menus';
export { downloadOriginal } from './actions/download';
export { linkForCopy } from './actions/copy-link';

export type ViewerCommandId =
  | 'file.openInChrome' | 'file.download' | 'file.copyLink' | 'file.print' | 'file.saveToLibrary'
  | 'view.fitWidth' | 'view.fitPage' | 'view.zoomIn' | 'view.zoomOut' | 'view.rotateCw' | 'view.rotateCcw'
  | 'view.twoPage' | 'view.presentation' | 'view.darkPages' | 'view.toggleRail'
  | 'tools.find' | 'tools.goToPage' | 'help.shortcuts' | 'help.about';

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
}

/** What the commands ask of the viewer's interface (App.tsx owns the dialogs, the page box and the notices). */
export interface ViewerUi {
  /** The escape hatch: this address in Chrome's own viewer (App shows Chrome's refusal, if it comes). */
  openInChrome(url: string): void;
  /** Puts the focus in the toolbar's page box, with its number selected (Ctrl+G). */
  focusPageField(): void;
  showShortcuts(): void;
  showAbout(): void;
  /** Copies the PDF's link and says whether it worked. */
  copyLink(source: string): void;
  /** Shows the "Preparing to print…" dialog with how far the pages are; null closes it. `cancel` stops the work. */
  printProgress(progress: { done: number; total: number; cancel: () => void } | null): void;
  /** A short note at the bottom of the window (a snackbar). */
  showNote(text: string): void;
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
  /** Filled by Task 30. */
  save: SaveController | null;
  /** The page list's zoom and scroll moves, while it is mounted. */
  pageList: RefObject<PageListApi | null>;
  ui: ViewerUi;
}

export type ViewerCommands = Map<ViewerCommandId, ViewerCommand>;

interface CommandSpec {
  label: string;
  icon: IconName;
  keys: KeyCombo[];
}

/**
 * Every command, in the order of the shortcut sheet. Dark pages were dropped (ruling R41), so `view.darkPages` is not
 * registered and no menu shows it.
 */
const SPECS: [ViewerCommandId, CommandSpec][] = [
  ['file.openInChrome', { label: "Open in Chrome's viewer", icon: 'open_in_new', keys: [] }],
  ['file.download', { label: 'Download', icon: 'download', keys: ['Ctrl+S'] }],
  ['file.copyLink', { label: 'Copy link', icon: 'link', keys: [] }],
  ['file.print', { label: 'Print', icon: 'print', keys: ['Ctrl+P'] }],
  ['file.saveToLibrary', { label: 'Save to library', icon: 'library_add', keys: ['Ctrl+Alt+S'] }],
  ['view.fitWidth', { label: 'Fit width', icon: 'fit_page_width', keys: ['Ctrl+0'] }],
  ['view.fitPage', { label: 'Fit page', icon: 'fit_page', keys: [] }],
  ['view.zoomIn', { label: 'Zoom in', icon: 'zoom_in', keys: ['Ctrl+=', 'Ctrl++'] }],
  ['view.zoomOut', { label: 'Zoom out', icon: 'zoom_out', keys: ['Ctrl+-'] }],
  ['view.rotateCw', { label: 'Rotate clockwise', icon: 'rotate_right', keys: ['Ctrl+]'] }],
  ['view.rotateCcw', { label: 'Rotate counter-clockwise', icon: 'rotate_left', keys: ['Ctrl+['] }],
  ['view.twoPage', { label: 'Two-page view', icon: 'auto_stories', keys: [] }],
  ['view.presentation', { label: 'Presentation mode', icon: 'slideshow', keys: [] }],
  ['view.toggleRail', { label: 'Thumbnails and outline', icon: 'photo_library', keys: ['F4'] }],
  ['tools.find', { label: 'Find', icon: 'find_in_page', keys: ['Ctrl+F'] }],
  ['tools.goToPage', { label: 'Go to page', icon: 'pageview', keys: ['Ctrl+G'] }],
  ['help.shortcuts', { label: 'Keyboard shortcuts', icon: 'keyboard', keys: ['?'] }],
  ['help.about', { label: 'About sickofpdfs', icon: 'info', keys: [] }],
];

type Behaviour = Pick<ViewerCommand, 'run' | 'enabled'> & Partial<Pick<ViewerCommand, 'checked'>>;

/** A command whose task has not landed yet: shown, greyed out, and its keys do nothing. */
const LATER: Behaviour = { run: () => {}, enabled: () => false };

const always = () => true;

/** A scale this close to a limit is at it: zoom in (or out) has nowhere to go. */
const LIMIT_EPSILON = 1e-3;

function assemble(behaviours: Partial<Record<ViewerCommandId, Behaviour>>): ViewerCommands {
  return new Map(SPECS.map(([id, spec]): [ViewerCommandId, ViewerCommand] => [id, { id, ...spec, ...(behaviours[id] ?? LATER) }]));
}

/** The link "Copy link" copies: the address the PDF was opened from. A file picked from disk has none. */
function linkOf(ctx: Pick<ViewerContext, 'params' | 'opened'>): string | null {
  return ctx.opened.loaded.sourceUrl === null ? null : (ctx.params.source ?? ctx.opened.loaded.sourceUrl);
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

/** Ctrl+Alt+S and File → Save to library (Task 30). A failed save is told by the App's note, so it is not rethrown. */
function saveToLibrary(save: SaveController | null): Behaviour {
  return { run: () => void save?.requestSave().catch(() => {}), enabled: () => save !== null && SAVABLE.has(save.state.kind) };
}

/** The commands for an open document. Rotate, two-page, presentation and find come later. */
export function createCommands(ctx: ViewerContext): ViewerCommands {
  const pages = () => ctx.pageList.current;
  const source = ctx.params.source;
  const link = linkOf(ctx);
  const scale = () => ctx.store.get().scale;
  return assemble({
    'file.openInChrome': { run: () => source !== null && ctx.ui.openInChrome(source), enabled: () => source !== null },
    'file.download': { run: () => downloadOriginal(ctx.opened.loaded.blob, ctx.opened.loaded.displayName), enabled: always },
    'file.copyLink': { run: () => link !== null && ctx.ui.copyLink(link), enabled: () => link !== null },
    'file.saveToLibrary': saveToLibrary(ctx.save),
    'file.print': { run: () => void printDocument(ctx), enabled: always },
    'view.fitWidth': { run: () => pages()?.zoomTo({ kind: 'fit-width' }), enabled: always },
    'view.fitPage': { run: () => fitPage(pages(), ctx.store), enabled: always },
    'view.zoomIn': { run: () => pages()?.zoomStep(1), enabled: () => scale() < MAX_SCALE - LIMIT_EPSILON },
    'view.zoomOut': { run: () => pages()?.zoomStep(-1), enabled: () => scale() > MIN_SCALE + LIMIT_EPSILON },
    'view.toggleRail': { run: () => ctx.store.set({ railOpen: !ctx.store.get().railOpen }), enabled: always, checked: () => ctx.store.get().railOpen },
    'tools.goToPage': { run: () => ctx.ui.focusPageField(), enabled: always },
    'help.shortcuts': { run: () => ctx.ui.showShortcuts(), enabled: always },
    'help.about': { run: () => ctx.ui.showAbout(), enabled: always },
  });
}

/**
 * The commands while no document is open (loading, an error card, the large-file note): the escape hatch, the link
 * and Help work; the rest are greyed out.
 */
export function createIdleCommands(o: { source: string | null; canOpenInChrome: boolean; ui: ViewerUi }): ViewerCommands {
  const { source, ui } = o;
  return assemble({
    'file.openInChrome': { run: () => source !== null && ui.openInChrome(source), enabled: () => source !== null && o.canOpenInChrome },
    'file.copyLink': { run: () => source !== null && ui.copyLink(source), enabled: () => source !== null },
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
 * A Ctrl combo without Alt is the viewer's even while its command is greyed out: it does nothing rather than let
 * Chrome print the viewer page, save it, open its find bar or zoom the browser. Single keys and Ctrl+Alt combos (F4,
 * ?, Ctrl+Alt+S) are left to the browser while their command is greyed out.
 */
function alwaysOurs(combo: KeyCombo): boolean {
  return combo.startsWith('Ctrl+') && !combo.includes('Alt+');
}

/** The shortcuts for installShortcuts: every command's keys, in command order. */
export function commandShortcuts(cmds: ViewerCommands): ShortcutDef[] {
  const defs: ShortcutDef[] = [];
  for (const c of cmds.values()) {
    const keys = [...c.keys, ...(HIDDEN_KEYS[c.id] ?? [])];
    const ours = keys.filter(alwaysOurs);
    const others = keys.filter((k) => !alwaysOurs(k));
    if (ours.length > 0) defs.push({ id: c.id, keys: ours, run: () => c.enabled() && c.run() });
    if (others.length > 0) defs.push({ id: c.id, keys: others, run: () => c.run(), enabled: () => c.enabled() });
  }
  return defs;
}
