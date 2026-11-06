// The figure toolbar (plan §4 F; spec "You click a chart. It gets a blue outline."): while a figure is selected, a small
// pill at its top-right corner offers Ask Claude and Explain this figure, so they are one click away and not only in
// the right-click menu. It is the viewer toolbar's own pill (#333537, 14/20 500 words in #c4c7c5), smaller. It never
// covers the figure's own words (its caption, the titles of its panels; TB6): it sits above the figure and its caption
// when the page has room there, else under them, and inside the figure's top edge only when the page has room for
// neither.
//
// It sits in the page list's overlay, so it scrolls with the page and takes its clicks above the text layer. It shows
// only while the Claude host is there and notes can be written. On a private PDF (R105) it still shows, with both buttons
// greyed out and the hint "Claude doesn't read private files" on hover and keyboard focus, as the menus' Claude rows have.
import { TextButton, Tooltip } from '@sop/ui';
import { normToCss, type PageBox, pdfRectToNorm, useViewerState } from '@sop/viewer';
import { type RefObject, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { PageListApi } from '@sop/viewer/react';
import type { FigureController } from '../../figures/controller';
import styles from './FigureToolbar.module.css';

export interface FigureToolbarProps {
  controller: FigureController;
  onAsk(this: void): void;
  onExplain(this: void): void;
  /** Why Claude can't be asked here ("Claude doesn't read private files"): both buttons are greyed out and say it. */
  disabledReason?: string | null;
}

/** The page list's overlay, once its first layout has made it. */
function useOverlay(pages: RefObject<PageListApi | null>): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(() => pages.current?.overlayHost() ?? null);
  useEffect(() => {
    if (el?.isConnected) return;
    let frame = 0;
    const look = () => {
      const found = pages.current?.overlayHost() ?? null;
      if (found) setEl(found);
      else frame = requestAnimationFrame(look);
    };
    look();
    return () => cancelAnimationFrame(frame);
  }, [pages, el]);
  return el;
}

/** A 0–1 box of a page, in the page list's content px (the page may be turned). */
function inContent(rect: readonly [number, number, number, number], box: PageBox): { x: number; y: number; width: number; height: number } {
  const sideways = box.rotation % 180 !== 0;
  const unrotated = { width: sideways ? box.height : box.width, height: sideways ? box.width : box.height };
  const b = normToCss([rect[0], rect[1], rect[2], rect[3]], unrotated, 1, box.rotation);
  return { x: box.left + b.x, y: box.top + b.y, width: b.width, height: b.height };
}

/** The room the pill needs beside the figure: about 40 px tall, and 8 px clear of it. */
const BAR_ROOM_PX = 48;

type Box = { x: number; y: number; width: number; height: number };

/**
 * Where the pill goes (TB6): above the figure and its caption (the block they make), when the page has room above it;
 * else under that block, when the page has room there; else inside the figure's top edge, the one place left on the
 * page. So it is never over the caption or the titles of the figure's panels when the page has any room. `page` and
 * `block` are content px; `top` is the edge the pill lines up with.
 */
export function toolbarPlace(page: Box, block: Box, figure: Box): { place: 'above' | 'inside' | 'below'; top: number } {
  if (block.y - page.y >= BAR_ROOM_PX) return { place: 'above', top: block.y };
  if (page.y + page.height - (block.y + block.height) >= BAR_ROOM_PX) return { place: 'below', top: block.y + block.height };
  return { place: 'inside', top: figure.y };
}

/** The smallest box holding both. */
function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function FigureToolbar({ controller, onAsk, onExplain, disabledReason = null }: FigureToolbarProps) {
  const { host } = controller;
  const selected = useSyncExternalStore(controller.subscribe, () => controller.state().selected);
  const overlay = useOverlay(host.pageList);
  // Laid out again with the pages (zoom, rotation, spread): the boxes are read again on each change.
  const layout = useViewerState(host.view, (v) => `${v.scale}|${v.viewRotation}|${v.spread}`);
  void layout;
  if (selected === null || overlay === null || !controller.editable()) return null;
  const box = host.pageList.current?.pageBoxes()[selected.page];
  const size = host.pages[selected.page];
  if (box === undefined || size === undefined) return null;
  const fig = inContent(selected.rect, box);
  const caption = selected.figure.captionRect === null ? null : inContent(pdfRectToNorm(selected.figure.captionRect, size), box);
  const { place, top } = toolbarPlace({ x: box.left, y: box.top, width: box.width, height: box.height }, caption === null ? fig : union(fig, caption), fig);
  const right = fig.x + fig.width;
  return createPortal(
    <div className={styles.bar} data-theme="dark" data-place={place} role="toolbar" aria-label="Figure" style={{ left: right, top }}>
      <BarButton label="Ask Claude" icon="auto_awesome" why={disabledReason} onClick={onAsk} />
      <BarButton label="Explain" icon="insert_chart" why={disabledReason} onClick={onExplain} title="Explain this figure" />
    </div>,
    overlay,
  );
}

/**
 * One of the pill's buttons. Greyed out with a reason, it stays focusable (aria-disabled, not disabled), so its tooltip can
 * say why on hover and on keyboard focus; pressing it does nothing.
 */
function BarButton({ label, icon, why, title, onClick }: { label: string; icon: 'auto_awesome' | 'insert_chart'; why: string | null; title?: string; onClick(this: void): void }) {
  if (why === null) {
    return <TextButton label={label} icon={icon} className={styles.button} onMouseDown={(e) => e.preventDefault()} onClick={onClick} {...(title !== undefined ? { title } : {})} />;
  }
  return (
    <Tooltip label={why}>
      <TextButton
        label={label}
        icon={icon}
        className={`${styles.button} ${styles.off}`}
        aria-disabled="true"
        aria-description={why}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => undefined}
      />
    </Tooltip>
  );
}
