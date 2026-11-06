// The figure toolbar (plan §4 F; spec "You click a chart. It gets a blue outline."): while a figure is selected, a small
// pill above its top-right corner offers Ask Claude and Explain this figure, so they are one click away and not only in
// the right-click menu. It is the viewer toolbar's own pill (#333537, 14/20 500 words in #c4c7c5), smaller.
//
// It sits in the page list's overlay, so it scrolls with the page and takes its clicks above the text layer. It shows
// only while the Claude host is there and notes can be written.
import { TextButton } from '@sop/ui';
import { normToCss, type PageBox, useViewerState } from '@sop/viewer';
import { type RefObject, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { PageListApi } from '@sop/viewer/react';
import type { FigureController } from '../../figures/controller';
import styles from './FigureToolbar.module.css';

export interface FigureToolbarProps {
  controller: FigureController;
  onAsk(this: void): void;
  onExplain(this: void): void;
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

/** The top-right corner of a 0–1 box of a page, in the page list's content px (the page may be turned). */
function topRight(rect: readonly [number, number, number, number], box: PageBox): { x: number; y: number } {
  const sideways = box.rotation % 180 !== 0;
  const unrotated = { width: sideways ? box.height : box.width, height: sideways ? box.width : box.height };
  const b = normToCss([rect[0], rect[1], rect[2], rect[3]], unrotated, 1, box.rotation);
  return { x: box.left + b.x + b.width, y: box.top + b.y };
}

export function FigureToolbar({ controller, onAsk, onExplain }: FigureToolbarProps) {
  const { host } = controller;
  const selected = useSyncExternalStore(controller.subscribe, () => controller.state().selected);
  const overlay = useOverlay(host.pageList);
  // Laid out again with the pages (zoom, rotation, spread): the boxes are read again on each change.
  const layout = useViewerState(host.view, (v) => `${v.scale}|${v.viewRotation}|${v.spread}`);
  void layout;
  if (selected === null || overlay === null || !controller.editable()) return null;
  const box = host.pageList.current?.pageBoxes()[selected.page];
  if (box === undefined) return null;
  const at = topRight(selected.rect, box);
  return createPortal(
    <div className={styles.bar} data-theme="dark" role="toolbar" aria-label="Figure" style={{ left: at.x, top: at.y }}>
      <TextButton label="Ask Claude" icon="asterisk" className={styles.button} onMouseDown={(e) => e.preventDefault()} onClick={onAsk} />
      <TextButton label="Explain" icon="insert_chart" className={styles.button} onMouseDown={(e) => e.preventDefault()} onClick={onExplain} title="Explain this figure" />
    </div>,
    overlay,
  );
}
