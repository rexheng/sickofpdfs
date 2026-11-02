import { DropdownMenu, Icon, IconButton, type MenuItemDef, PillToolbar, TextField, ToolbarSeparator } from '@sop/ui';
import { createViewerStore, useViewerState, type ViewerStore, type ZoomMode } from '@sop/viewer';
import { type ComponentPropsWithRef, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import type { ViewerCommand, ViewerCommandId, ViewerCommands } from '../commands';
import { formatCombo } from './menus';
import styles from './Toolbar.module.css';

/** What the pill needs from the open document. */
export interface ToolbarView {
  store: ViewerStore;
  pageCount: number;
  /** Shows page `index` (0-based) at the top. */
  onGoToPage(this: void, index: number): void;
  onZoom(this: void, mode: ZoomMode): void;
  pageFieldRef: RefObject<HTMLInputElement | null>;
}

export interface ToolbarProps {
  commands: ViewerCommands;
  /**
   * The open document; null while the PDF is still opening. The pill is then drawn at once, in its place, with
   * "Page – / –" and its buttons greyed out (each says why), so nothing pops in or moves when the PDF arrives.
   */
  view: ToolbarView | null;
  /** Where the focus goes after the zoom list was used with the pointer: the pages (App.tsx). */
  returnFocus?: () => void;
  /** The right end of the pill (the scan hint). */
  end?: ReactNode;
}

/** The view state while no document is open: it never changes. */
const IDLE_STORE = createViewerStore();

/**
 * Drive's toolbar pill (02 section 4.10), 16 px in, in a 48 px row under the header: "Page [n] / N", Download and
 * Print, then zoom out, the zoom level (a menu of fit modes and presets) and zoom in, then Find (Ctrl+F).
 */
export function Toolbar({ commands, view, returnFocus, end }: ToolbarProps) {
  // The zoom buttons grey out at 25% and 400%; the store's scale and zoom mode are what change that.
  const store = view?.store ?? IDLE_STORE;
  const scale = useViewerState(store, (s) => s.scale);
  const zoom = useViewerState(store, (s) => s.zoom);
  const button = (id: ViewerCommandId) => <CommandButton cmd={commands.get(id)} />;
  return (
    <div className={styles.row} data-viewer-chrome="">
      <PillToolbar label="Document">
        <span className={styles.pageLabel} aria-hidden="true">
          Page
        </span>
        {view === null ? (
          <TextField label="Page" value="" width={BASE_WIDTH} disabled onChange={() => {}} />
        ) : (
          <PageField store={view.store} pageCount={view.pageCount} onGoToPage={view.onGoToPage} inputRef={view.pageFieldRef} />
        )}
        <span className={styles.total}>/ {view === null ? '–' : view.pageCount}</span>
        <ToolbarSeparator />
        <span className={styles.fileGroup}>
          {button('file.download')}
          {button('file.print')}
        </span>
        <ToolbarSeparator />
        <span className={styles.zoomGroup}>
          {button('view.zoomOut')}
          {view === null ? (
            <ZoomButton percent="–" disabled />
          ) : (
            <ZoomMenu scale={scale} zoom={zoom} commands={commands} onZoom={view.onZoom} returnFocus={returnFocus} />
          )}
          {button('view.zoomIn')}
        </span>
        <ToolbarSeparator />
        {button('tools.find')}
        {end !== undefined && <span className={styles.end}>{end}</span>}
      </PillToolbar>
    </div>
  );
}

/**
 * The toolbar's icons for its commands (Drive's: a minus and a plus for zoom, not magnifiers). Find is the plain
 * magnifier people look for, not the menu's page-and-magnifier.
 */
const TOOLBAR_ICONS: Partial<Record<ViewerCommandId, ViewerCommand['icon']>> = { 'view.zoomOut': 'remove', 'view.zoomIn': 'add', 'tools.find': 'search' };

/**
 * Drive's + and − are drawn about 15 px wide; Material's at 20 px are 12 px and look thin beside Drive's, so these two
 * use the 24 px glyph in the 32 px button.
 */
const LARGE_GLYPH = new Set<ViewerCommandId>(['view.zoomOut', 'view.zoomIn']);

function CommandButton({ cmd }: { cmd: ViewerCommand | undefined }) {
  if (cmd === undefined || !cmd.built) return null;
  const icon = TOOLBAR_ICONS[cmd.id] ?? cmd.icon;
  if (icon === undefined) return null;
  const key = cmd.keys[0];
  const enabled = cmd.enabled();
  return (
    <IconButton
      icon={icon}
      label={cmd.label}
      {...(LARGE_GLYPH.has(cmd.id) ? { iconSize: 24 as const } : {})}
      {...(key !== undefined ? { shortcut: formatCombo(key) } : {})}
      disabled={!enabled}
      disabledReason={enabled ? undefined : cmd.disabledReason?.()}
      onClick={() => cmd.run()}
    />
  );
}

/** The zoom list: Drive's (Fit, then 50–200%), with fit page and the larger steps up to Chrome's 400%. */
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** A scale this close to a preset is that preset. */
const PRESET_EPSILON = 1e-3;

interface ZoomMenuProps {
  scale: number;
  zoom: ZoomMode;
  commands: ViewerCommands;
  onZoom: (mode: ZoomMode) => void;
  returnFocus: (() => void) | undefined;
}

/**
 * The zoom list. The current choice is drawn in the primary colour: Fit width or Fit page while in that mode, else the
 * preset the pages are at (the capped fit width a document opens at, R61, reads as its percentage).
 */
function ZoomMenu({ scale, zoom, commands, onZoom, returnFocus }: ZoomMenuProps) {
  const percent = `${Math.round(scale * 100)}%`;
  const fitMode = (zoom.kind === 'fit-width' && zoom.max === undefined) || zoom.kind === 'fit-page';
  // Fit width and Fit page are the View menu's commands, so both places behave the same.
  const fit = (id: ViewerCommandId): MenuItemDef[] => {
    const cmd = commands.get(id);
    if (cmd === undefined || !cmd.built) return [];
    return [{ kind: 'item', id, label: cmd.label, disabled: !cmd.enabled(), selected: cmd.checked?.() === true, onSelect: () => cmd.run() }];
  };
  const items: MenuItemDef[] = [
    ...fit('view.fitWidth'),
    ...fit('view.fitPage'),
    { kind: 'separator' },
    ...ZOOM_PRESETS.map(
      (z): MenuItemDef => ({
        kind: 'item',
        id: `zoom-${z}`,
        label: `${z * 100}%`,
        selected: !fitMode && Math.abs(scale - z) < PRESET_EPSILON,
        onSelect: () => onZoom({ kind: 'scale', scale: z }),
      }),
    ),
  ];
  return <DropdownMenu trigger={<ZoomButton percent={percent} />} items={items} {...(returnFocus !== undefined ? { returnFocus } : {})} />;
}

/** Drive's zoom box: "100%" and a drop-down arrow in a 73 × 32 pill. Radix gives it its menu props and ref. */
function ZoomButton({ percent, className, ...rest }: ComponentPropsWithRef<'button'> & { percent: string }) {
  return (
    <button type="button" {...rest} className={className === undefined ? styles.zoom : `${styles.zoom} ${className}`} aria-label={`Zoom, ${percent}`}>
      <span className={styles.zoomValue}>{percent}</span>
      <Icon name="arrow_drop_down" size={20} className={styles.zoomArrow} />
    </button>
  );
}

/** How long the note under the page box stays after a number was moved into range. */
const NOTE_MS = 3000;

/** The page box takes this many px per digit beyond two (Drive's is 33 px wide for up to 99 pages). */
const PX_PER_DIGIT = 9;
const BASE_WIDTH = 33;

interface PageFieldProps {
  store: ViewerStore;
  pageCount: number;
  onGoToPage: (index: number) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

/** What the note under the page box says when the number typed was not a page: where it went instead. */
function rangeNote(typed: number, pageCount: number): string {
  if (typed < 1) return 'Pages start at 1. Showing page 1.';
  return pageCount === 1 ? 'This PDF has 1 page.' : `This PDF has ${pageCount} pages. Showing the last one.`;
}

/** While the page box has the focus (a click, Ctrl+G, Tools → Go to page), the note under it says what to do. */
const HOW_TO = 'Type a page number, then press Enter';

/**
 * "Page [n]": shows the page in view and follows scrolling. Type a number and press Enter to go there; while the box
 * has the focus, a note under it says so. A number past either end goes to the first or the last page, as Chrome's
 * page box does, and the note says so (never a silent red flash). Escape or leaving the box puts it back. After a jump
 * or Escape the box lets go of the focus, so the reading keys (arrows, Page Down) move the pages again.
 */
function PageField({ store, pageCount, onGoToPage, inputRef }: PageFieldProps) {
  const current = useViewerState(store, (s) => s.currentPage);
  const [typed, setTyped] = useState<string | null>(null);
  // After a jump the page in view may not be the one asked for (the last pages cannot reach the top): show the one asked
  // for until the view moves on.
  const [jump, setJump] = useState<{ target: number; landed: number } | null>(null);
  const [note, setNote] = useState<{ text: string } | null>(null);
  const [focused, setFocused] = useState(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectOnMouseUp = useRef(false);
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  useEffect(() => {
    if (jump !== null && jump.landed !== current) setJump(null);
  }, [jump, current]);

  const shownPage = jump !== null && jump.landed === current ? jump.target : current;
  const value = typed ?? String(shownPage + 1);
  const width = BASE_WIDTH + Math.max(0, String(pageCount).length - 2) * PX_PER_DIGIT;

  const showNote = (text: string) => {
    setNote({ text });
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), NOTE_MS);
  };

  const commit = () => {
    if (typed === null) return;
    setTyped(null);
    if (!/^\d+$/u.test(typed)) return; // nothing typed: the box shows the page in view again
    const n = Number(typed);
    const page = Math.min(pageCount, Math.max(1, n));
    if (page !== n) showNote(rangeNote(n, pageCount));
    else setNote(null);
    onGoToPage(page - 1);
    const landed = store.get().currentPage;
    // In two-page view a page lands with its pair, and the box shows the pair's left page (Task 26).
    const pairLanded = store.get().spread === 'two-page' && Math.floor(landed / 2) === Math.floor((page - 1) / 2);
    setJump(landed === page - 1 || pairLanded ? null : { target: page - 1, landed });
    inputRef.current?.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    setTyped(null);
    inputRef.current?.blur();
  };
  const onFocus = (e: FocusEvent<HTMLInputElement>) => {
    e.currentTarget.select();
    selectOnMouseUp.current = true;
    setFocused(true);
  };
  const shown = note ?? (focused ? { text: HOW_TO } : null);

  return (
    <span className={styles.pageField}>
      <TextField
        ref={inputRef}
        label="Page"
        value={value}
        width={width}
        inputMode="numeric"
        autoComplete="off"
        enterKeyHint="go"
        onChange={(v) => setTyped(v.replace(/\D/gu, ''))}
        onEnter={commit}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        // A click into the box selects its number, as Chrome's page box does; the click's own mouseup would undo that.
        onMouseUp={(e) => {
          if (!selectOnMouseUp.current) return;
          selectOnMouseUp.current = false;
          e.preventDefault();
        }}
        onBlur={() => {
          setTyped(null);
          setFocused(false);
        }}
      />
      <span role="status" className={styles.pageNote}>
        {shown !== null && (
          <span key={shown.text} className={styles.pageNoteText}>
            {shown.text}
          </span>
        )}
      </span>
    </span>
  );
}
