import { IconButton } from '@sop/ui';
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
  /** The page list. It sits beside the rail; in a window under 1100 px the rail lies over it instead. */
  children: ReactNode;
}

/**
 * Drive's navigation rail (02 section 4.10), under the toolbar pill on the left: a column of two 40 px toggles,
 * Thumbnails and Outline (the selected one on a #333537 disc), then the thumbnails or the outline. A pill at the bottom
 * left hides the rail, and shows it again. The rail starts open when the window is 1100 px wide or more (Reader).
 */
export function NavRail({ store, scheduler, pages, outline, onPage, onOutline, onToggle, children }: NavRailProps) {
  const open = useViewerState(store, (s) => s.railOpen);
  const [tab, setTab] = useState<'thumbnails' | 'outline'>('thumbnails');
  const hasOutline = outline !== null && outline.length > 0;
  const shown = tab === 'outline' && hasOutline ? 'outline' : 'thumbnails';
  return (
    <>
      {open && (
        <div className={cx(styles.rail, shown === 'outline' && styles.wide)}>
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
          </div>
          <div className={styles.panel}>
            {shown === 'outline' && outline !== null ? (
              <OutlinePanel items={outline} onSelect={onOutline} />
            ) : (
              <ThumbnailRail scheduler={scheduler} pages={pages} store={store} onSelect={onPage} />
            )}
          </div>
        </div>
      )}
      <div className={styles.pill} data-viewer-chrome="">
        <IconButton
          icon={open ? 'left_panel_close' : 'left_panel_open'}
          label={open ? 'Hide navigation pane' : 'Show navigation pane'}
          shortcut="F4"
          size={40}
          onClick={onToggle}
        />
      </div>
      <div className={cx(styles.pages, open && (shown === 'outline' ? styles.besideWide : styles.beside))}>{children}</div>
    </>
  );
}
