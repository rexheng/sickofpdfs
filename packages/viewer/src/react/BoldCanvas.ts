// Synthetic bold on a page (rulings R90b, R90c): one canvas for each picture the page shows (its full render, or the
// base and its tiles), the same size in device px and in the same place, in the page's underlay
// (PageLayerContext.underlay, blended with darken; light text's bold in its lighten twin). Each is drawn in the same
// task as the page list paints its picture (PageLayerContext.onPaint), so at any zoom the bold arrives in the same
// frame as the page. Bold word starts and the owner's bold marks each keep one; where both bold a glyph, the blend
// shows it once.
import { useLayoutEffect, useRef, useState } from 'react';
import type { PageSize } from '../backend/types';
import { type BoldGlyph, isLightFill, paintBold } from '../marks/bold-painter';
import { pageToDevice } from '../marks/synthetic-bold';
import type { PagePaint } from './page-driver';
import type { PageLayerContext } from './PageView';

/** How heavy a bold is drawn: the gain on each face's own bold, and the edge darkening (paintBold). */
export interface BoldLook {
  gain: number;
  boost: number;
}

/** The face's own bold, no edge darkening: bold marks, and Medium. */
export const PLAIN_LOOK: BoldLook = { gain: 1, boost: 0 };

/** Device px a point in the page's pictures now (undefined before the first is painted): what prepareGlyphs needs. */
export function devicePxPerPt(ctx: Pick<PageLayerContext, 'paints'>, page: PageSize): number | undefined {
  const p = ctx.paints()[0];
  if (p === undefined) return undefined;
  const [a, b] = pageToDevice(page, p.viewRotation, p.width, p.height, p.rect);
  return Math.hypot(a, b);
}

/** How long bold that comes after its page's picture takes to fade in (R90c: no plain-then-bold flash). */
const FADE_MS = 160;

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const rectKey = (p: PagePaint) => (p.rect ? `${p.rect.x},${p.rect.y},${p.rect.width},${p.rect.height}` : 'page');

/**
 * The canvases of one tone (dark text in the darken underlay, light text in the lighten one), by picture. Each canvas
 * is opaque: white under dark text, black under light text. With a partly transparent source, `darken` at an edge
 * pixel turns into a multiply ((1 − α)·page for black text): PDFium's own edge and ours would darken each other, and
 * even a bold of no gain would add ink (measured: 25% more ink on a paragraph). Opaque, the blend is exactly the darker
 * of the page's pixel and ours (`lighten`: the lighter), so each edge is the stronger of the two, never both. Within a
 * tone the tiles cover the base, and the tone's box blends with the other bold layers and with the page.
 */
class ToneLayer {
  readonly container: HTMLDivElement;
  readonly canvases = new Map<string, { canvas: HTMLCanvasElement; drawn: string }>();

  constructor(
    parent: HTMLElement,
    name: string,
    readonly tone: 'dark' | 'light',
  ) {
    this.container = document.createElement('div');
    this.container.className = name;
    this.container.setAttribute('aria-hidden', 'true');
    this.container.style.cssText = `position:absolute;inset:0;pointer-events:none;mix-blend-mode:${tone === 'dark' ? 'darken' : 'lighten'}`;
    parent.append(this.container);
  }

  /** What a canvas of this tone holds where there is no bold: nothing to the blend. */
  get ground(): string {
    return this.tone === 'dark' ? '#fff' : '#000';
  }
}

export class BoldCanvas {
  private readonly layers: ToneLayer[];
  private glyphs: readonly BoldGlyph[] = [];
  private hasLight = false;
  private gain = 1;
  private boost = 0;
  private version = 0;
  private readonly stop: () => void;

  constructor(
    parents: { dark: HTMLElement; light: HTMLElement | null },
    private readonly page: PageSize,
    private readonly ctx: Pick<PageLayerContext, 'paints' | 'onPaint'>,
    name: string,
    private readonly onDrawn?: (glyphs: number) => void,
  ) {
    this.layers = [new ToneLayer(parents.dark, name, 'dark')];
    if (parents.light) this.layers.push(new ToneLayer(parents.light, `${name} ${name}-light`, 'light'));
    this.stop = ctx.onPaint(() => this.sync());
  }

  /**
   * The glyphs to draw (none: the canvases go), the gain on their faces' bold and the edge darkening (paintBold's `gain`
   * and `boost`). Redraws every picture now. `fadeIn`: glyphs that come to a page whose picture is already on screen
   * fade in over FADE_MS instead of appearing in one frame (not with reduced motion).
   */
  setGlyphs(glyphs: readonly BoldGlyph[], gain = 1, boost = 0, fadeIn = false): void {
    if (glyphs === this.glyphs && gain === this.gain && boost === this.boost) return;
    if (fadeIn && this.glyphs.length === 0 && glyphs.length > 0 && this.ctx.paints().length > 0 && !reducedMotion()) this.fade();
    this.glyphs = glyphs;
    this.hasLight = glyphs.some((g) => isLightFill(g.fill));
    this.gain = gain;
    this.boost = boost;
    this.version++;
    this.sync();
  }

  /** Brings the canvases in line with the page's pictures, drawing those that are new or out of date. */
  sync(): void {
    let drew = 0;
    let any = false;
    for (const layer of this.layers) {
      const used = this.glyphs.length > 0 && (layer.tone === 'dark' || this.hasLight);
      const paints = used ? this.ctx.paints() : [];
      const keep = new Set(paints.map((p) => p.key));
      for (const [key, c] of layer.canvases) {
        if (keep.has(key)) continue;
        c.canvas.remove();
        layer.canvases.delete(key);
      }
      for (const paint of paints) {
        let entry = layer.canvases.get(paint.key);
        if (!entry) {
          const canvas = document.createElement('canvas');
          canvas.style.position = 'absolute';
          canvas.style.display = 'block';
          layer.container.append(canvas);
          layer.canvases.set(paint.key, (entry = { canvas, drawn: '' }));
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
        context.fillStyle = layer.ground;
        context.fillRect(0, 0, canvas.width, canvas.height);
        const device = pageToDevice(this.page, paint.viewRotation, paint.width, paint.height, paint.rect);
        drew += paintBold(context, this.glyphs, device, { clip: { x0: 0, y0: 0, x1: paint.width, y1: paint.height }, gain: this.gain, boost: this.boost, tone: layer.tone });
        entry.drawn = want;
        any = true;
      }
    }
    if (any) this.onDrawn?.(drew);
  }

  /** Shows the next drawing from nothing to full over FADE_MS. */
  private fade(): void {
    for (const layer of this.layers) {
      const style = layer.container.style;
      style.transition = 'none';
      style.opacity = '0';
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const layer of this.layers) {
          const style = layer.container.style;
          style.transition = `opacity ${FADE_MS}ms ease-out`;
          style.opacity = '1';
        }
      }),
    );
  }

  dispose(): void {
    this.stop();
    for (const layer of this.layers) {
      layer.container.remove();
      layer.canvases.clear();
    }
  }
}

/**
 * Keeps a BoldCanvas for page `page` while the component is mounted, showing `glyphs` (null or none: nothing) with
 * `look`: the gain on their faces' bold and the edge darkening (paintBold). `onDrawn` runs after each redraw, with how
 * many glyphs were drawn.
 */
export function useBoldCanvas(ctx: PageLayerContext, page: PageSize, glyphs: readonly BoldGlyph[] | null, name: string, onDrawn?: (glyphs: number) => void, look: BoldLook = PLAIN_LOOK, fadeIn = false): void {
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
    const made = new BoldCanvas({ dark: parent, light: ctx.underlay('lighten') }, page, ctx, name, (n) => drawnRef.current?.(n));
    painter.current = made;
    return () => {
      made.dispose();
      if (painter.current === made) painter.current = null;
    };
  }, [ctx, page, name, retry]);
  const { gain, boost } = look;
  useLayoutEffect(() => {
    painter.current?.setGlyphs(glyphs ?? [], gain, boost, fadeIn);
  }, [glyphs, gain, boost, fadeIn, ctx, page, name, retry]);
}
