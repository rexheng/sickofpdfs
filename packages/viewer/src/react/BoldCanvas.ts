// Synthetic bold on a page (ruling R90b): one canvas for each picture the page shows (its full render, or the base and
// its tiles), the same size in device px and in the same place, in the page's underlay (PageLayerContext.underlay,
// blended with darken). Each is drawn in the same task as the page list paints its picture (PageLayerContext.onPaint),
// so at any zoom the bold arrives in the same frame as the page. Bold word starts and the owner's bold marks each keep
// one; where both bold a glyph, darken shows it once.
import { useLayoutEffect, useRef, useState } from 'react';
import type { PageSize } from '../backend/types';
import { type BoldGlyph, paintBold } from '../marks/bold-painter';
import { pageToDevice } from '../marks/synthetic-bold';
import type { PagePaint } from './page-driver';
import type { PageLayerContext } from './PageView';

const rectKey = (p: PagePaint) => (p.rect ? `${p.rect.x},${p.rect.y},${p.rect.width},${p.rect.height}` : 'page');

export class BoldCanvas {
  private readonly container: HTMLDivElement;
  private readonly canvases = new Map<string, { canvas: HTMLCanvasElement; drawn: string }>();
  private glyphs: readonly BoldGlyph[] = [];
  private version = 0;
  private readonly stop: () => void;

  constructor(
    parent: HTMLElement,
    private readonly page: PageSize,
    private readonly ctx: Pick<PageLayerContext, 'paints' | 'onPaint'>,
    name: string,
    private readonly onDrawn?: (glyphs: number) => void,
  ) {
    this.container = document.createElement('div');
    this.container.className = name;
    this.container.setAttribute('aria-hidden', 'true');
    this.container.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    parent.append(this.container);
    this.stop = ctx.onPaint(() => this.sync());
  }

  /** The glyphs to draw (none: the canvases go). Redraws every picture now. */
  setGlyphs(glyphs: readonly BoldGlyph[]): void {
    if (glyphs === this.glyphs) return;
    this.glyphs = glyphs;
    this.version++;
    this.sync();
  }

  /** Brings the canvases in line with the page's pictures, drawing those that are new or out of date. */
  sync(): void {
    const paints = this.glyphs.length === 0 ? [] : this.ctx.paints();
    const keep = new Set(paints.map((p) => p.key));
    for (const [key, c] of this.canvases) {
      if (keep.has(key)) continue;
      c.canvas.remove();
      this.canvases.delete(key);
    }
    let drew = 0;
    let any = false;
    for (const paint of paints) {
      let entry = this.canvases.get(paint.key);
      if (!entry) {
        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.display = 'block';
        this.container.append(canvas);
        this.canvases.set(paint.key, (entry = { canvas, drawn: '' }));
      }
      const { canvas } = entry;
      const pct = (v: number) => `${v * 100}%`;
      Object.assign(canvas.style, { left: pct(paint.box.left), top: pct(paint.box.top), width: pct(paint.box.width), height: pct(paint.box.height) });
      const want = `${this.version}|${paint.width}x${paint.height}|${paint.viewRotation}|${rectKey(paint)}`;
      if (entry.drawn === want) continue;
      if (canvas.width !== paint.width || canvas.height !== paint.height) {
        canvas.width = paint.width;
        canvas.height = paint.height;
      }
      const context = canvas.getContext('2d');
      if (!context) continue;
      context.clearRect(0, 0, canvas.width, canvas.height);
      const device = pageToDevice(this.page, paint.viewRotation, paint.width, paint.height, paint.rect);
      drew += paintBold(context, this.glyphs, device, { x0: 0, y0: 0, x1: paint.width, y1: paint.height });
      entry.drawn = want;
      any = true;
    }
    if (any) this.onDrawn?.(drew);
  }

  dispose(): void {
    this.stop();
    this.container.remove();
    this.canvases.clear();
  }
}

/**
 * Keeps a BoldCanvas for page `page` while the component is mounted, showing `glyphs` (null or none: nothing).
 * `onDrawn` runs after each redraw, with how many glyphs were drawn.
 */
export function useBoldCanvas(ctx: PageLayerContext, page: PageSize, glyphs: readonly BoldGlyph[] | null, name: string, onDrawn?: (glyphs: number) => void): void {
  const painter = useRef<BoldCanvas | null>(null);
  const drawnRef = useRef(onDrawn);
  useLayoutEffect(() => {
    drawnRef.current = onDrawn;
  });
  // The underlay is in the DOM before this layer's effects run; if not yet, try again after this commit.
  const [retry, setRetry] = useState(0);
  useLayoutEffect(() => {
    const parent = ctx.underlay();
    if (!parent) {
      if (retry < 3) queueMicrotask(() => setRetry((n) => n + 1));
      return;
    }
    const made = new BoldCanvas(parent, page, ctx, name, (n) => drawnRef.current?.(n));
    painter.current = made;
    return () => {
      made.dispose();
      if (painter.current === made) painter.current = null;
    };
  }, [ctx, page, name, retry]);
  useLayoutEffect(() => {
    painter.current?.setGlyphs(glyphs ?? []);
  }, [glyphs, ctx, page, name, retry]);
}
