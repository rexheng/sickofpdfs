import { memo, type ReactNode, useLayoutEffect, useMemo, useRef } from 'react';
import type { PageBox } from '../layout/page-layout';
import type { PageDriver } from './page-driver';
import styles from './PageList.module.css';

/** What a page's layers (renderPage) are told besides the box. */
export interface PageLayerContext {
  /** Device px per CSS px. */
  dpr: number;
  /** Resolves once the page's full render at the current zoom is on screen. */
  whenPainted(): Promise<void>;
}

export interface PageViewProps {
  box: PageBox;
  /** The full render's size in device px (pageDeviceSize): the box is exactly this size on screen. */
  device: { width: number; height: number };
  /** Device px per CSS px: the box is snapped to whole device pixels, so a bitmap pixel is a screen pixel. */
  dpr: number;
  driver: PageDriver;
  /** The text and link layers (Task 22), drawn over the page. */
  renderPage?: (box: PageBox, ctx: PageLayerContext) => ReactNode;
}

/** A CSS length on a whole device pixel: where PageView puts a page box's edges. */
export const snapToDevice = (v: number, dpr: number) => Math.round(v * dpr) / dpr;

/**
 * One page: a box in the placeholder colour with the page shadow, holding (bottom to top) the preview canvas, the full
 * canvas, the tiles, and the layer slot. The full canvas comes first in the DOM, so `[data-page-index] canvas` is the
 * full render. Painting is done by the PageDriver, which gets this DOM before the browser paints (a layout effect),
 * so a page whose preview is cached is never shown blank.
 */
export const PageView = memo(function PageView({ box, device, dpr, driver, renderPage }: PageViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const full = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const tiles = useRef<HTMLDivElement>(null);
  const index = box.index;
  const layerCtx = useMemo<PageLayerContext>(() => ({ dpr, whenPainted: () => driver.whenPainted(index) }), [driver, index, dpr]);

  useLayoutEffect(() => {
    const slot = { index, root: root.current!, full: full.current!, preview: preview.current!, tiles: tiles.current! };
    driver.attach(slot);
    return () => driver.detach(slot);
  }, [driver, index]);

  const left = snapToDevice(box.left, dpr);
  const top = snapToDevice(box.top, dpr);
  return (
    <div
      ref={root}
      className={styles.page}
      data-page-index={index}
      style={{ left, top, width: device.width / dpr, height: device.height / dpr }}
    >
      <canvas ref={full} className={styles.full} aria-hidden="true" />
      <canvas ref={preview} className={styles.preview} aria-hidden="true" />
      <div ref={tiles} className={styles.tiles} />
      {renderPage && <div className={styles.layers}>{renderPage(box, layerCtx)}</div>}
    </div>
  );
});
