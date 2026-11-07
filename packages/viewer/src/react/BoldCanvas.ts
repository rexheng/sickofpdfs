// Synthetic bold on a page (rulings R90b, R90c): one canvas for each picture the page shows (its full render, or the
// base and its tiles), the same size in device px and in the same place, in the page's underlay
// (PageLayerContext.underlay, blended with darken; light text's bold in its lighten twin). Each is drawn in the same
// task as the page list paints its picture (PageLayerContext.onPaint), so at any zoom the bold arrives in the same
// frame as the page. Bold word starts and the owner's bold marks each keep one; where both bold a glyph, the blend
// shows it once.
//
// Words with no outline (a scan's recognised text, R106) are bold in the picture's own ink (marks/scan-ink.ts): planned
// once from the page's full render (or base; a sharp one from a copy at PLAN_PX_PER_PT), so every picture bolds the same
// letters, then grown on each picture's own pixels. Tiles share their lines: a line is grown once all the tiles under
// it are shown, on the whole page's grid at the tiles' size, so a letter across two tiles grows the same in both.
import { useLayoutEffect, useRef, useState } from 'react';
import type { PageSize } from '../backend/types';
import { type BoldGlyph, isLightFill, paintBold } from '../marks/bold-painter';
import { copyBlock, inkLines, type InkPatch, type InkPlan, type InkSource, type InkWord, paintInk, planInk } from '../marks/scan-ink';
import { pageToDevice } from '../marks/synthetic-bold';
import type { TurnMatrix } from '../view/page-transform';
import type { PagePaint } from './page-driver';
import type { PageLayerContext } from './PageView';
import type { GrownLetter } from '../marks/scan-ink';
import type { GrownPage, ScanInkPages } from './scan-ink-pages';

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

const NO_INK: readonly (readonly InkWord[])[] = [];

/** Pictures sharper than this many device px a point are planned from a copy this sharp: plenty to tell letters apart. */
export const PLAN_PX_PER_PT = 3;

const sameLists = (a: readonly (readonly InkWord[])[], b: readonly (readonly InkWord[])[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** One canvas to read pictures' pixels through (grown as needed). */
let scratch: { read: OffscreenCanvasRenderingContext2D } | null = null;
function scratchOf(): NonNullable<typeof scratch> {
  return (scratch ??= { read: new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })! });
}

const fit = (c: OffscreenCanvasRenderingContext2D, w: number, h: number) => {
  if (c.canvas.width < w || c.canvas.height < h) {
    c.canvas.width = Math.max(c.canvas.width, w);
    c.canvas.height = Math.max(c.canvas.height, h);
  }
};

/**
 * A picture as one grid of device px for scan-ink: the full render (or base) alone, or a tile with every tile of the
 * same size round it (their place on the whole page's grid at that size). `device` is that grid's page → px matrix and
 * `offset` where `paint` sits on it. The pixels round the ink words are read once, on the first read: reading a
 * picture back from the screen costs about the same for a word as for a page.
 */
export function inkSourceOf(page: PageSize, paint: PagePaint, all: readonly PagePaint[], words: readonly InkWord[], scale = 1): { src: InkSource; device: TurnMatrix; offset: { x: number; y: number } } {
  const gridW = Math.round(paint.width / paint.box.width);
  const gridH = Math.round(paint.height / paint.box.height);
  const device = pageToDevice(page, paint.viewRotation, gridW * scale, gridH * scale);
  const at = (p: PagePaint) => ({ x: Math.round(p.box.left * gridW), y: Math.round(p.box.top * gridH) });
  const pictures = paint.rect === undefined ? [paint] : all.filter((p) => p.rect !== undefined && Math.round(p.width / p.box.width) === gridW && Math.round(p.height / p.box.height) === gridH);
  let region: { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } | null = null;
  const load = () => {
    const b = wordsBox(device, words);
    const x = Math.max(0, Math.floor(b.x0));
    const y = Math.max(0, Math.floor(b.y0));
    const w = Math.max(1, Math.min(Math.ceil(gridW * scale), Math.ceil(b.x1)) - x);
    const h = Math.max(1, Math.min(Math.ceil(gridH * scale), Math.ceil(b.y1)) - y);
    const c = scratchOf().read;
    fit(c, w, h);
    c.clearRect(0, 0, w, h);
    for (const p of pictures) {
      const o = at(p);
      if (o.x * scale >= x + w || o.y * scale >= y + h || (o.x + p.width) * scale <= x || (o.y + p.height) * scale <= y) continue;
      if (scale === 1) c.drawImage(p.source, o.x - x, o.y - y);
      else {
        c.imageSmoothingQuality = 'medium';
        c.drawImage(p.source, o.x * scale - x, o.y * scale - y, p.width * scale, p.height * scale);
      }
    }
    return { x, y, w, h, data: c.getImageData(0, 0, w, h).data };
  };
  const src: InkSource = {
    read(x, y, w, h) {
      const r = (region ??= load());
      // Inside what was read: the block itself. Past it (the page's edge): a copy, with the rest blank.
      if (x >= r.x && y >= r.y && x + w <= r.x + r.w && y + h <= r.y + r.h) return { data: r.data, x: r.x, y: r.y, width: r.w };
      const block = copyBlock(r.data, r.w, r.h, x - r.x, y - r.y, w, h);
      return { ...block, x, y };
    },
  };
  return { src, device, offset: at(paint) };
}

/** The device px box round `words` on a grid made with `device`, a line's height out on every side. */
function wordsBox(device: TurnMatrix, words: readonly InkWord[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let pad = 0;
  for (const w of words)
    for (const c of w.chars) {
      const ax = device[0] * c.x + device[2] * c.y + device[4];
      const ay = device[1] * c.x + device[3] * c.y + device[5];
      const bx = device[0] * (c.x + c.width) + device[2] * (c.y + c.height) + device[4];
      const by = device[1] * (c.x + c.width) + device[3] * (c.y + c.height) + device[5];
      x0 = Math.min(x0, ax, bx);
      x1 = Math.max(x1, ax, bx);
      y0 = Math.min(y0, ay, by);
      y1 = Math.max(y1, ay, by);
      pad = Math.max(pad, Math.abs(bx - ax), Math.abs(by - ay));
    }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

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
  /** By picture: its canvas, what it was drawn for, and with only ink on it, the boxes of its patches (else null). */
  readonly canvases = new Map<string, { canvas: HTMLCanvasElement; drawn: string; inkOnly: { x: number; y: number; w: number; h: number }[] | null }>();

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
  /** Words with no outline, one list a bold range (each list kept as the same array while its range is). */
  private ink: readonly (readonly InkWord[])[] = NO_INK;
  /** Each range's plan (scan-ink), and from which picture; the pictures redraw when a plan is made (planGen). */
  private plans = new WeakMap<readonly InkWord[], { key: string; plan: InkPlan }>();
  private planGen = 0;
  /** Each picture's patches of each plan, by what the picture is (its size, turn, part, the tiles round it) and the look. */
  private patches = new Map<string, WeakMap<InkPlan, { patches: InkPatch[]; letters: number }>>();
  private hasLight = false;
  /** The page's words read ahead (null: none), and for each range the words that were not, for those letters. */
  private fast: { pages: ScanInkPages; index: number } | null = null;
  private missing = new WeakMap<readonly InkWord[], Map<string, { grown: GrownPage; version: number; words: InkWord[] }>>();
  private gain = 1;
  private boost = 0;
  private version = 0;
  private readonly stop: () => void;

  constructor(
    parents: { dark: HTMLElement; light: HTMLElement | null },
    private readonly page: PageSize,
    private readonly ctx: Pick<PageLayerContext, 'paints' | 'onPaint' | 'dpr'>,
    name: string,
    private readonly onDrawn?: (glyphs: number) => void,
  ) {
    this.layers = [new ToneLayer(parents.dark, name, 'dark')];
    if (parents.light) this.layers.push(new ToneLayer(parents.light, `${name} ${name}-light`, 'light'));
    this.stop = ctx.onPaint(() => this.sync());
  }

  /**
   * The glyphs to draw (none: the canvases go), the gain on their faces' bold and the edge darkening (paintBold's `gain`
   * and `boost`), and the words with no outline, one list a range (R106). Redraws every picture now. `fadeIn`: glyphs
   * that come to a page whose picture is already on screen fade in over FADE_MS instead of appearing in one frame (not
   * with reduced motion).
   */
  setGlyphs(glyphs: readonly BoldGlyph[], gain = 1, boost = 0, fadeIn = false, ink: readonly (readonly InkWord[])[] = NO_INK): void {
    const words = ink.filter((w) => w.length > 0);
    if (glyphs === this.glyphs && gain === this.gain && boost === this.boost && sameLists(words, this.ink)) return;
    if (fadeIn && this.glyphs.length === 0 && glyphs.length > 0 && this.ctx.paints().length > 0 && !reducedMotion()) this.fade();
    this.ink = words;
    this.glyphs = glyphs;
    this.hasLight = glyphs.some((g) => isLightFill(g.fill));
    this.gain = gain;
    this.boost = boost;
    this.version++;
    this.sync();
  }

  /** Reads ahead from `pages` (page `index`): see sync. */
  setAhead(pages: ScanInkPages | null, index: number): void {
    if (this.fast?.pages === pages && this.fast?.index === index) return;
    this.stopAhead?.();
    this.stopAhead = null;
    this.fast = pages ? { pages, index } : null;
    // Once the page is read ahead, its canvas is made (sync keeps it warm).
    if (pages) this.stopAhead = pages.onAhead((i) => i === index && this.sync());
  }

  private stopAhead: (() => void) | null = null;

  /** The words of range `list` that `grown` does not hold (the same array while that holds). */
  private missingOf(list: readonly InkWord[], grown: GrownPage): readonly InkWord[] {
    let byPicture = this.missing.get(list);
    if (!byPicture) this.missing.set(list, (byPicture = new Map<string, { grown: GrownPage; version: number; words: InkWord[] }>()));
    const had = byPicture.get(grown.key);
    if (had?.grown === grown && had.version === grown.version) return had.words;
    const words = list.filter((w) => !grown.words.has(w.start));
    // The same array while the same words are missing, so their plan is kept.
    const same = had && had.words.length === words.length && had.words.every((w, k) => w === words[k]);
    const kept = same ? had.words : words.length === list.length ? (list as InkWord[]) : words;
    byPicture.set(grown.key, { grown, version: grown.version, words: kept });
    return kept;
  }

  /**
   * Each range's plan, made from the page's full render (or base) and made again when that picture changes. A range is
   * left out while no such picture is shown yet.
   */
  private plansNow(paints: readonly PagePaint[], lists: readonly (readonly InkWord[])[]): InkPlan[] {
    if (lists.length === 0) return [];
    const from = paints.find((p) => p.rect === undefined);
    const key = from ? `${from.width}x${from.height}|${from.viewRotation}` : '';
    const out: InkPlan[] = [];
    // A sharp picture is planned from a smaller copy (the plan is in points; the letters are grown on the picture itself).
    const scale = from ? Math.min(1, PLAN_PX_PER_PT / devicePxPerPt({ paints: () => [from] }, this.page)!) : 1;
    for (const words of lists) {
      let made = this.plans.get(words);
      // The page's own plan, read ahead, serves as it is (each word's letters bold as the mark covers them).
      const ahead = this.fast && made?.key !== 'ahead' ? this.fast.pages.plannedWords(this.fast.index, words) : null;
      if (ahead) {
        this.plans.set(words, (made = { key: 'ahead', plan: { words: ahead.filter((pw) => pw.letters.some((l) => l.bold)) } }));
        this.planGen++;
      } else if (from && made?.key !== key && made?.key !== 'ahead') {
        const { src, device } = inkSourceOf(this.page, from, paints, words, scale);
        const plan = planInk(src, device, words, scale === 1);
        this.plans.set(words, (made = { key, plan }));
        this.planGen++;
        // The picture it was planned from is painted from the same reading.
        if (scale === 1) this.patchCache(`${this.pictureKey(from, '')}|${this.gain}|${this.boost}`).set(plan, paintInk(src, device, plan, { gain: this.gain, boost: this.boost }, undefined, true));
      }
      if (made) out.push(made.plan);
    }
    return out;
  }

  private patchCache(key: string): WeakMap<InkPlan, { patches: InkPatch[]; letters: number }> {
    let cache = this.patches.get(key);
    if (!cache) this.patches.set(key, (cache = new WeakMap()));
    return cache;
  }

  /** What a picture is, for its patches: its size, turn and part (a tile also which of its lines can be read, `lines`). */
  private pictureKey(paint: PagePaint, lines: string): string {
    return `${paint.key}|${paint.width}x${paint.height}|${paint.viewRotation}|${rectKey(paint)}${paint.rect ? `|${lines}` : ''}`;
  }

  /**
   * The tiles' grid (the whole page at the tiles' size), and for each plan its lines on that grid with their patches once
   * made. A line's patch is made once every tile under it is shown (it reads them all), and then serves every tile it
   * meets: so a letter across two tiles grows the same in both, and a new tile costs only the lines it completes.
   */
  private grids = new Map<string, WeakMap<InkPlan, { lines: ReturnType<typeof inkLines>; made: ({ patches: InkPatch[]; letters: number } | undefined)[] }>>();

  private gridOf(paint: PagePaint): { key: string; device: TurnMatrix; w: number; h: number; at: (p: PagePaint) => { x: number; y: number } } {
    const w = Math.round(paint.width / paint.box.width);
    const h = Math.round(paint.height / paint.box.height);
    return {
      key: `${w}x${h}|${paint.viewRotation}|${this.gain}|${this.boost}`,
      device: pageToDevice(this.page, paint.viewRotation, w, h),
      w,
      h,
      at: (p) => ({ x: Math.round(p.box.left * w), y: Math.round(p.box.top * h) }),
    };
  }

  /** For a tile: each plan's lines that meet it, and whether all the tiles under each are shown yet. */
  private tileLines(paint: PagePaint, all: readonly PagePaint[], plans: readonly InkPlan[], used: Set<string>): { plan: InkPlan; index: number; ready: boolean }[] {
    const g = this.gridOf(paint);
    used.add(`grid|${g.key}`);
    let byPlan = this.grids.get(g.key);
    if (!byPlan) this.grids.set(g.key, (byPlan = new WeakMap()));
    const o = g.at(paint);
    const tiles = all.filter((p) => p.rect !== undefined && Math.round(p.width / p.box.width) === g.w && Math.round(p.height / p.box.height) === g.h).map((p) => ({ ...g.at(p), w: p.width, h: p.height }));
    const covered = (b: { x0: number; y0: number; x1: number; y1: number }) => {
      const x0 = Math.max(0, b.x0);
      const y0 = Math.max(0, b.y0);
      const x1 = Math.min(g.w, b.x1);
      const y1 = Math.min(g.h, b.y1);
      let area = 0;
      for (const t of tiles) area += Math.max(0, Math.min(x1, t.x + t.w) - Math.max(x0, t.x)) * Math.max(0, Math.min(y1, t.y + t.h) - Math.max(y0, t.y));
      return area >= (x1 - x0) * (y1 - y0) - 1;
    };
    const out: { plan: InkPlan; index: number; ready: boolean }[] = [];
    for (const plan of plans) {
      let entry = byPlan.get(plan);
      if (!entry) {
        const lines = inkLines(g.device, plan);
        byPlan.set(plan, (entry = { lines, made: lines.map(() => undefined) }));
      }
      entry.lines.forEach((l, index) => {
        const b = l.box;
        if (b.x1 < o.x || b.x0 > o.x + paint.width || b.y1 < o.y || b.y0 > o.y + paint.height) return;
        out.push({ plan, index, ready: entry.made[index] !== undefined || covered(b) });
      });
    }
    return out;
  }

  /** The ink patches of one picture for `plans` (scan-ink's paintInk), on that picture's own px; each plan's once. */
  private inkPatches(paint: PagePaint, all: readonly PagePaint[], plans: readonly InkPlan[], key: string, used: Set<string>): { patches: InkPatch[]; offset: { x: number; y: number }; letters: number } {
    const patches: InkPatch[] = [];
    let letters = 0;
    if (paint.rect !== undefined) {
      // A tile: the patches of its lines on the tiles' grid.
      const g = this.gridOf(paint);
      for (const { plan, index, ready } of this.tileLines(paint, all, plans, used)) {
        if (!ready) continue;
        const entry = this.grids.get(g.key)!.get(plan)!;
        let got = entry.made[index];
        if (!got) {
          const { src, device } = inkSourceOf(this.page, paint, all, entry.lines[index].words);
          entry.made[index] = got = paintInk(src, device, plan, { gain: this.gain, boost: this.boost }, undefined, false, index);
        }
        patches.push(...got.patches);
        letters += got.letters;
      }
      return { patches, offset: g.at(paint), letters };
    }
    const cacheKey = `${key}|${this.gain}|${this.boost}`;
    used.add(cacheKey);
    const cache = this.patchCache(cacheKey);
    for (const plan of plans) {
      let got = cache.get(plan);
      if (!got) {
        const { src, device } = inkSourceOf(this.page, paint, all, plan.words.map((w) => w.word));
        cache.set(plan, (got = paintInk(src, device, plan, { gain: this.gain, boost: this.boost })));
      }
      patches.push(...got.patches);
      letters += got.letters;
    }
    return { patches, offset: { x: 0, y: 0 }, letters };
  }

  /** Brings the canvases in line with the page's pictures, drawing those that are new or out of date. */
  sync(): void {
    let drew = 0;
    let any = false;
    const all = this.ctx.paints();
    // The page's words read ahead (scan-ink-pages), on its full render and on its tiles' grid: a mark only copies its
    // letters' grown px. The words not read ahead yet are planned and grown now.
    const full = all.find((p) => p.rect === undefined);
    const tile = all.find((p) => p.rect !== undefined);
    const look = { gain: this.gain, boost: this.boost };
    const readAhead = (paint: PagePaint | undefined) => {
      const grown = paint && this.fast && this.ink.length > 0 ? this.fast.pages.grown(this.fast.index, paint, look) : null;
      const missing = grown ? this.ink.map((l) => this.missingOf(l, grown)).filter((l) => l.length > 0) : this.ink;
      const letters = grown ? fastLetters(grown, this.ink) : null;
      const width = paint ? Math.round(paint.width / paint.box.width) : 0;
      // One patch a tone for the whole mark, on that grid (a tile draws its part of it).
      const patches = letters ? { dark: aheadPatch(letters.dark, 'dark', width), light: aheadPatch(letters.light, 'light', width) } : null;
      return { missing, letters, patches, plans: this.plansNow(all, missing) };
    };
    const onFull = readAhead(full);
    const onTiles = tile ? readAhead(tile) : null;
    const fullPlans = onFull.plans;
    const tilePlans = onTiles?.plans ?? [];
    const isLight = (plans: readonly InkPlan[]) => plans.some((p) => p.words.some((w) => w.light && w.letters.some((l) => l.bold)));
    const inkLight = isLight(fullPlans) || isLight(tilePlans) || (onFull.patches?.light ?? null) !== null || (onTiles?.patches?.light ?? null) !== null;
    const hasInk = this.ink.length > 0;

    const drawnPatches = new Map<string, ReturnType<BoldCanvas['inkPatches']>>();
    const used = new Set<string>();
    for (const layer of this.layers) {
      const wanted = (this.glyphs.length > 0 || hasInk) && (layer.tone === 'dark' || this.hasLight || inkLight);
      // A page read ahead keeps its dark canvases made and white (warm), so the first mark does not pay for making them.
      const warm = !wanted && layer.tone === 'dark' && this.fast !== null ? all.filter((p) => this.fast!.pages.hasAhead(this.fast!.index, p)) : [];
      const paints = wanted ? all : warm;
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
          layer.canvases.set(paint.key, (entry = { canvas, drawn: '', inkOnly: null }));
        }
        const { canvas } = entry;
        const pct = (v: number) => `${v * 100}%`;
        // A tile redraws when another of its lines can be read (the tiles under it are all shown).
        const here = paint.rect !== undefined ? onTiles! : onFull;
        const plans = here.plans;
        const lines = hasInk && paint.rect !== undefined ? this.tileLines(paint, all, plans, used).map((l) => (l.ready ? 1 : 0)).join('') : '';
        const picture = this.pictureKey(paint, lines);
        const want = `${this.version}|${this.planGen}|${picture}${here.letters ? `|ahead${here.letters.letters}|${here.missing.length}` : ''}`;
        if (entry.drawn === want) {
          if (hasInk) used.add(`${picture}|${this.gain}|${this.boost}`);
          continue;
        }
        // The ink patches of this picture, in its px: grown now (the plans), and read ahead.
        const inkHere: InkPatch[] = [];
        if (hasInk) {
          let got = drawnPatches.get(paint.key);
          if (!got) {
            drawnPatches.set(paint.key, (got = this.inkPatches(paint, all, plans, picture, used)));
            drew += got.letters;
            drew += here.letters?.letters ?? 0;
          }
          const offset = got.offset;
          for (const p of got.patches) if (p.tone === layer.tone) inkHere.push({ ...p, x: p.x - offset.x, y: p.y - offset.y });
          const p = here.patches?.[layer.tone];
          if (p) inkHere.push({ ...p, x: p.x - offset.x, y: p.y - offset.y });
        }
        // Every canvas is the picture's size and opaque (see ToneLayer: a smaller one, laid over part of the page, showed
        // seams down the stems). With only ink on it, a drawing clears just the last one's patches: filling a whole
        // page's canvas costs more than the bold. A page read ahead keeps its canvas made and white (warm), so the first
        // mark does not pay for making it.
        Object.assign(canvas.style, { left: pct(paint.box.left), top: pct(paint.box.top), width: pct(paint.box.width), height: pct(paint.box.height) });
        let fresh = false;
        if (canvas.width !== paint.width || canvas.height !== paint.height) {
          canvas.width = paint.width;
          canvas.height = paint.height;
          fresh = true;
        }
        const context = canvas.getContext('2d');
        if (!context) continue;
        context.fillStyle = layer.ground;
        const inkAlone = this.glyphs.length === 0;
        if (inkAlone && !fresh && entry.inkOnly !== null) for (const r of entry.inkOnly) context.fillRect(r.x, r.y, r.w, r.h);
        else context.fillRect(0, 0, canvas.width, canvas.height);
        if (!inkAlone) {
          const device = pageToDevice(this.page, paint.viewRotation, paint.width, paint.height, paint.rect);
          drew += paintBold(context, this.glyphs, device, { clip: { x0: 0, y0: 0, x1: paint.width, y1: paint.height }, gain: this.gain, boost: this.boost, tone: layer.tone });
        }
        drawPatches(context, inkHere, layer.tone, { x: 0, y: 0 });
        entry.inkOnly = inkAlone ? inkHere.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })) : null;
        entry.drawn = want;
        any = true;
      }
    }
    // Patches of pictures (and grids) no longer shown go.
    for (const key of this.patches.keys()) if (!used.has(key)) this.patches.delete(key);
    for (const key of this.grids.keys()) if (!used.has(`grid|${key}`)) this.grids.delete(key);
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
    this.stopAhead?.();
    for (const layer of this.layers) {
      layer.container.remove();
      layer.canvases.clear();
    }
  }
}

/** The marked letters of words read ahead, of one tone. */
type AheadPx = GrownLetter[];

/** Every letter `lists` mark, from the page's words read ahead (a letter mostly inside the mark), by tone. */
function fastLetters(grown: GrownPage, lists: readonly (readonly InkWord[])[]): { dark: AheadPx; light: AheadPx; letters: number } {
  const out = { dark: [] as GrownLetter[], light: [] as GrownLetter[], letters: 0 };
  for (const list of lists)
    for (const w of list) {
      const letters = grown.words.get(w.start);
      if (!letters) continue;
      for (const l of letters) {
        const inside = Math.max(0, Math.min(w.to, l.chars[1]) - Math.max(w.from, l.chars[0]));
        if (2 * inside <= l.chars[1] - l.chars[0] || l.px.length === 0) continue;
        out[l.tone].push(l);
        out.letters++;
      }
    }
  return out;
}

/** Letters read ahead as one patch of their tone (`width`: the picture's), or null when there are none. */
function aheadPatch(letters: AheadPx, tone: 'dark' | 'light', width: number): InkPatch | null {
  if (letters.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const l of letters) {
    x0 = Math.min(x0, l.box.x0);
    x1 = Math.max(x1, l.box.x1);
    y0 = Math.min(y0, l.box.y0);
    y1 = Math.max(y1, l.box.y1);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const rgba = new Uint8ClampedArray(4 * w * h);
  new Uint32Array(rgba.buffer).fill(tone === 'dark' ? 0xffffffff : 0xff000000);
  const dark = tone === 'dark';
  for (const l of letters) {
    const { px, rgb } = l;
    for (let k = 0; k < px.length; k++) {
      const i = px[k];
      const x = i % width;
      const q = 4 * (((i - x) / width - y0) * w + (x - x0));
      // Where two letters' px meet, the darker (lighter) stays.
      for (let c = 0; c < 3; c++) {
        const v = rgb[3 * k + c];
        if (dark ? v < rgba[q + c] : v > rgba[q + c]) rgba[q + c] = v;
      }
    }
  }
  return { x: x0, y: y0, w, h, rgba, tone };
}

/** Blends the patches of one tone onto a canvas of that tone (darken for dark ink, lighten for light), at `offset`. */
function drawPatches(context: CanvasRenderingContext2D, patches: readonly InkPatch[], tone: 'dark' | 'light', offset: { x: number; y: number }): void {
  context.save();
  context.globalCompositeOperation = tone === 'dark' ? 'darken' : 'lighten';
  for (const patch of patches) {
    if (patch.tone !== tone) continue;
    const x = patch.x - offset.x;
    const y = patch.y - offset.y;
    // Only what falls on this canvas (a tile shows a part of the page).
    if (x >= context.canvas.width || y >= context.canvas.height || x + patch.w <= 0 || y + patch.h <= 0) continue;
    context.drawImage(patchCanvas(patch), 0, 0, patch.w, patch.h, x, y, patch.w, patch.h);
  }
  context.restore();
}

/** A patch put on a canvas of its own once, so the tiles it spans each copy it without putting it again. */
const patchCanvases = new WeakMap<Uint8ClampedArray, OffscreenCanvas>();
function patchCanvas(patch: InkPatch): OffscreenCanvas {
  let c = patchCanvases.get(patch.rgba);
  if (!c) {
    c = new OffscreenCanvas(patch.w, patch.h);
    c.getContext('2d')!.putImageData(new ImageData(patch.rgba as Uint8ClampedArray<ArrayBuffer>, patch.w, patch.h), 0, 0);
    patchCanvases.set(patch.rgba, c);
  }
  return c;
}

/**
 * Keeps a BoldCanvas for page `page` while the component is mounted, showing `glyphs` (null or none: nothing) and the
 * words with no outline `ink` (one list a range, R106) with `look`: the gain on their faces' bold and the edge
 * darkening (paintBold). `onDrawn` runs after each redraw, with how many glyphs and ink letters were drawn.
 */
export function useBoldCanvas(
  ctx: PageLayerContext,
  page: PageSize,
  glyphs: readonly BoldGlyph[] | null,
  name: string,
  onDrawn?: (glyphs: number) => void,
  look: BoldLook = PLAIN_LOOK,
  fadeIn = false,
  ink: readonly (readonly InkWord[])[] = NO_INK,
  ahead?: { pages: ScanInkPages; index: number },
): void {
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
    painter.current?.setAhead(ahead?.pages ?? null, ahead?.index ?? 0);
    painter.current?.setGlyphs(glyphs ?? [], gain, boost, fadeIn, ink);
  }, [glyphs, gain, boost, fadeIn, ink, ahead?.pages, ahead?.index, ctx, page, name, retry]);
}
