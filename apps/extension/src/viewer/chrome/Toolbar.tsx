import { DropdownMenu, Icon, IconButton, type MenuItemDef, PillToolbar, TextField, ToolbarSeparator } from '@sop/ui';
import { useViewerState, type ViewerStore, type ZoomMode } from '@sop/viewer';
import { type ComponentPropsWithRef, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import type { ViewerCommand, ViewerCommandId, ViewerCommands } from '../commands';
import { formatCombo } from './menus';
import styles from './Toolbar.module.css';

export interface ToolbarProps {
  commands: ViewerCommands;
  store: ViewerStore;
  pageCount: number;
  /** Shows page `index` (0-based) at the top. */
  onGoToPage(this: void, index: number): void;
  onZoom(this: void, mode: ZoomMode): void;
  pageFieldRef: RefObject<HTMLInputElement | null>;
  /** The right end of the pill (the scan hint). */
  end?: ReactNode;
}

/**
 * Drive's toolbar pill (02 section 4.10), 16 px in, in a 48 px row under the header: "Page [n] / N", Download and
 * Print, then zoom out, the zoom level (a menu of fit modes and presets) and zoom in.
 */
export function Toolbar({ commands, store, pageCount, onGoToPage, onZoom, pageFieldRef, end }: ToolbarProps) {
  // The zoom buttons grey out at 25% and 400%; the store's scale is what changes that.
  const scale = useViewerState(store, (s) => s.scale);
  const button = (id: ViewerCommandId) => <CommandButton cmd={commands.get(id)} />;
  return (
    <div className={styles.row} data-viewer-chrome="">
      <PillToolbar label="Document">
        <span className={styles.pageLabel} aria-hidden="true">
          Page
        </span>
        <PageField store={store} pageCount={pageCount} onGoToPage={onGoToPage} inputRef={pageFieldRef} />
        <span className={styles.total}>/ {pageCount}</span>
        <ToolbarSeparator />
        <span className={styles.fileGroup}>
          {button('file.download')}
          {button('file.print')}
        </span>
        <ToolbarSeparator />
        <span className={styles.zoomGroup}>
          {button('view.zoomOut')}
          <ZoomMenu scale={scale} commands={commands} onZoom={onZoom} />
          {button('view.zoomIn')}
        </span>
        {end !== undefined && <span className={styles.end}>{end}</span>}
      </PillToolbar>
    </div>
  );
}

/** The toolbar's icons for its commands (Drive's: a minus and a plus for zoom, not magnifiers). */
const TOOLBAR_ICONS: Partial<Record<ViewerCommandId, ViewerCommand['icon']>> = { 'view.zoomOut': 'remove', 'view.zoomIn': 'add' };

function CommandButton({ cmd }: { cmd: ViewerCommand | undefined }) {
  if (cmd === undefined) return null;
  const icon = TOOLBAR_ICONS[cmd.id] ?? cmd.icon;
  if (icon === undefined) return null;
  const key = cmd.keys[0];
  return (
    <IconButton
      icon={icon}
      label={cmd.label}
      {...(key !== undefined ? { shortcut: formatCombo(key) } : {})}
      disabled={!cmd.enabled()}
      onClick={() => cmd.run()}
    />
  );
}

/** The zoom list: Drive's (Fit, then 50–200%), with fit page and the larger steps up to Chrome's 400%. */
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function ZoomMenu({ scale, commands, onZoom }: { scale: number; commands: ViewerCommands; onZoom: (mode: ZoomMode) => void }) {
  const percent = `${Math.round(scale * 100)}%`;
  // Fit width and Fit page are the View menu's commands, so both places behave the same.
  const fit = (id: ViewerCommandId): MenuItemDef[] => {
    const cmd = commands.get(id);
    return cmd === undefined ? [] : [{ kind: 'item', id, label: cmd.label, disabled: !cmd.enabled(), onSelect: () => cmd.run() }];
  };
  const items: MenuItemDef[] = [
    ...fit('view.fitWidth'),
    ...fit('view.fitPage'),
    { kind: 'separator' },
    ...ZOOM_PRESETS.map((z): MenuItemDef => ({ kind: 'item', id: `zoom-${z}`, label: `${z * 100}%`, onSelect: () => onZoom({ kind: 'scale', scale: z }) })),
  ];
  return <DropdownMenu trigger={<ZoomButton percent={percent} />} items={items} />;
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

/** A wrong page number shows as an error this long, then the box looks normal again. */
const INVALID_MS = 1000;

/** The page box takes this many px per digit beyond two (Drive's is 33 px wide for up to 99 pages). */
const PX_PER_DIGIT = 9;
const BASE_WIDTH = 33;

interface PageFieldProps {
  store: ViewerStore;
  pageCount: number;
  onGoToPage: (index: number) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * "Page [n]": shows the page in view and follows scrolling. Type a number and press Enter to go there; a number that is
 * not a page puts the box back and flags it for a second. Escape or leaving the box puts it back too. After a jump or
 * Escape the box lets go of the focus, so the reading keys (arrows, Page Down) move the pages again.
 */
function PageField({ store, pageCount, onGoToPage, inputRef }: PageFieldProps) {
  const current = useViewerState(store, (s) => s.currentPage);
  const [typed, setTyped] = useState<string | null>(null);
  // After a jump the page in view may not be the one asked for (the last pages cannot reach the top): show the one asked
  // for until the view moves on.
  const [jump, setJump] = useState<{ target: number; landed: number } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const invalidTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectOnMouseUp = useRef(false);
  useEffect(() => () => clearTimeout(invalidTimer.current), []);
  useEffect(() => {
    if (jump !== null && jump.landed !== current) setJump(null);
  }, [jump, current]);

  const shownPage = jump !== null && jump.landed === current ? jump.target : current;
  const value = typed ?? String(shownPage + 1);
  const width = BASE_WIDTH + Math.max(0, String(pageCount).length - 2) * PX_PER_DIGIT;

  const flagInvalid = () => {
    setInvalid(true);
    clearTimeout(invalidTimer.current);
    invalidTimer.current = setTimeout(() => setInvalid(false), INVALID_MS);
  };

  const commit = () => {
    if (typed === null) return;
    const n = /^\d+$/u.test(typed) ? Number(typed) : NaN;
    setTyped(null);
    if (!(n >= 1 && n <= pageCount)) {
      if (typed !== '') flagInvalid();
      requestAnimationFrame(() => inputRef.current?.select());
      return;
    }
    setInvalid(false);
    onGoToPage(n - 1);
    const landed = store.get().currentPage;
    setJump(landed === n - 1 ? null : { target: n - 1, landed });
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
  };

  return (
    <TextField
      ref={inputRef}
      label="Page"
      value={value}
      width={width}
      invalid={invalid}
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
      onBlur={() => setTyped(null)}
    />
  );
}
