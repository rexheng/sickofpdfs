import { IconButton, type IconName } from '@sop/ui';
import { type LinkTarget, type OutlineItem, type PageSize, type RenderScheduler, useViewerState, type ViewerStore } from '@sop/viewer';
import { OutlinePanel, ThumbnailRail } from '@sop/viewer/react';
import { type ReactNode, useState } from 'react';
import styles from './NavRail.module.css';

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

export interface NavRailProps {
  store: ViewerStore;
  /** The tab's one render queue: thumbnails are the page list's previews. */
  scheduler: RenderScheduler;
  pages: PageSize[];
  /** The PDF's outline; null until it has been read. With no items, the Outline button is not shown. */
  outline: OutlineItem[] | null;
  /** A thumbnail was clicked: show page `i`. */
  onPage(this: void, i: number): void;
  /** An outline item was picked. */
  onOutline(this: void, t: LinkTarget): void;
  /** Opens or closes the rail (View → Thumbnails and outline, F4). */
  onToggle(this: void): void;
  /** R108: thumbnails were dragged (or moved with Alt+Up and Alt+Down): move `pages` to just before position `before`. */
  onMovePages?(this: void, pages: number[], before: number): void;
  /** R108: the thumbnails' menu was asked for, for `pages`, at a point in the window. */
  onPageMenu?(this: void, pages: number[], at: { x: number; y: number }): void;
  /** The page list. It sits beside the rail; in a window under 1100 px the rail lies over it instead. */
  children: ReactNode;
  /** More tabs after Thumbnails and Outline (the figures feature's Figures tab), each in the thumbnails' width. */
  tabs?: readonly RailTab[];
}

/** A tab of the rail that a feature adds: its toggle, and what it shows. */
export interface RailTab {
  id: string;
  icon: IconName;
  label: string;
  panel: ReactNode;
}

/**
 * Drive's navigation rail (02 section 4.10), under the toolbar pill on the left: a column of two 40 px toggles,
 * Thumbnails and Outline (the selected one on a #333537 disc), then the thumbnails or the outline. A pill at the bottom
 * left hides the rail, and shows it again. The rail starts open when the window is 1100 px wide or more (Reader).
 */
export function NavRail({ store, scheduler, pages, outline, onPage, onOutline, onToggle, onMovePages, onPageMenu, children, tabs }: NavRailProps) {
  const open = useViewerState(store, (s) => s.railOpen);
  const [tab, setTab] = useState<string>('thumbnails');
  const hasOutline = outline !== null && outline.length > 0;
  const extra = tabs?.find((t) => t.id === tab);
  const shown = tab === 'outline' && hasOutline ? 'outline' : extra !== undefined ? extra.id : 'thumbnails';
  // The rail's width is fixed: the pages always sit beside the thumbnails' width, so switching tabs never moves them
  // (TB4 fix round). Only the outline is drawn wider, so its titles can be read: it lies over the canvas beside it.
  const wide = shown === 'outline';
  return (
    <>
      {open && (
        <div className={cx(styles.rail, wide && styles.wide)}>
          <div className={styles.tools} data-viewer-chrome="">
            <IconButton
              icon="photo_library"
              label="Thumbnails"
              size={40}
              pressed={shown === 'thumbnails'}
              className={styles.toggle}
              onClick={() => setTab('thumbnails')}
            />
            {hasOutline && (
              <IconButton icon="toc" label="Outline" size={40} pressed={shown === 'outline'} className={styles.toggle} onClick={() => setTab('outline')} />
            )}
            {tabs?.map((t) => (
              <IconButton key={t.id} icon={t.icon} label={t.label} size={40} pressed={shown === t.id} className={styles.toggle} onClick={() => setTab(t.id)} />
            ))}
          </div>
          <div className={styles.panel}>
            {shown === 'outline' && outline !== null ? (
              <OutlinePanel items={outline} onSelect={onOutline} />
            ) : extra !== undefined ? (
              extra.panel
            ) : (
              <ThumbnailRail
                scheduler={scheduler}
                pages={pages}
                store={store}
                onSelect={onPage}
                {...(onMovePages ? { onMove: onMovePages } : {})}
                {...(onPageMenu ? { onMenu: onPageMenu } : {})}
              />
            )}
          </div>
        </div>
      )}
      <div className={styles.pill} data-viewer-chrome="" data-nav-rail={open ? 'open' : 'closed'}>
        <IconButton
          icon={open ? 'left_panel_close' : 'left_panel_open'}
          label={open ? 'Hide navigation pane' : 'Show navigation pane'}
          shortcut="F4"
          size={40}
          onClick={onToggle}
        />
      </div>
      {/* data-page-column: the notes panel's edge moves this column's end while it is dragged (notes-panel/PanelEdge.tsx). */}
      <div className={cx(styles.pages, open && styles.beside)} data-page-column="">
        {children}
      </div>
    </>
  );
}
