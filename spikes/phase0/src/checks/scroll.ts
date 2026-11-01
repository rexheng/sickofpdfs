// P0-3 scroll check:
//   spike.html?check=scroll&workers=1|2&file=<pdf url>&pattern=steady&pxPerSec=3000&seconds=20
//   spike.html?check=scroll&workers=1|2&file=<pdf url>&pattern=jump&targets=400,120,599
// A minimal virtual page list: every page at fit width, absolutely positioned in one scroll
// container, mounted while it lies within two screens of the viewport. Rendering is pulled, never
// queued ahead: each engine worker gets one call at a time, the most urgent one wanted right now —
//   1. a preview (PREVIEW_SCALE × DPR) of each visible page, then of the PREVIEW_AHEAD pages after
//      them in the scroll direction; previews stay in an LRU of PREVIEW_CACHE bitmaps;
//   2. a full render (fit width × DPR) of each visible page.
// So work for pages that went out of range is never started (cancelled), and a full render that
// comes back for an unmounted page is dropped. With workers=2 the document is open in both workers
// and pages go by parity (createFileWorkerEngine), so a page's calls always go to the same worker.
//
// "Blank" is the time from a page entering the viewport (the scroll position is set inside
// requestAnimationFrame) to the first paint of its canvas, preview or full. A page that leaves the
// viewport, or is still visible when the run ends, without being painted is blank until then.
// Timing starts once the first screen and its previews are drawn: the first page is P0-1's budget.
import { createFileWorkerEngine, type SpikeDoc, type SpikeEngine } from '../engine/client';
import { withTimeout } from './render';

const PAGE_GAP = 16; // CSS px around and between pages (Phase 1's PAGE_GAP)
const MOUNT_SCREENS = 2;
const PREVIEW_SCALE = 0.15; // × DPR, device px per point
const PREVIEW_AHEAD = 10;
const PREVIEW_CACHE = 300;
const FRAMES_PER_SECOND = 60; // the steady scroll moves pxPerSec / 60 each animation frame
const STEP_TIMEOUT_MS = 20_000;
const PLACEHOLDER = '#d3d4d5';

type Kind = 'preview' | 'full';
interface Job {
  page: number;
  kind: Kind;
}
interface Range {
  first: number;
  last: number; // inclusive; first > last when empty
}
interface Mounted {
  el: HTMLDivElement;
  painted: Kind | null;
}
interface Blank {
  page: number;
  ms: number;
  until: 'paint' | 'left' | 'end';
}

const inRange = (i: number, r: Range) => i >= r.first && i <= r.last;
/** `count` page numbers from `from`, stepping by `step`. */
const seq = (from: number, count: number, step: 1 | -1) => Array.from({ length: Math.max(0, count) }, (_, k) => from + k * step);
const round1 = (v: number) => Math.round(v * 10) / 10;
/** Nearest-rank percentile. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round1(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!);
}
const stats = (values: number[]) => ({
  n: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: percentile(values, 1),
});

class PageList {
  private readonly scroller = document.createElement('div');
  private readonly sizer = document.createElement('div');
  private readonly boxes: { top: number; left: number; width: number; height: number }[];
  private readonly fullScale: number;
  private readonly previewScale = PREVIEW_SCALE * devicePixelRatio;
  private readonly mounted = new Map<number, Mounted>();
  /** Preview bitmaps by page, least recently used first. */
  private readonly previews = new Map<number, ImageBitmap>();
  private readonly inFlight: (Job | null)[];
  private visible: Range = { first: 0, last: -1 };
  private lastTop = 0;
  private direction: 1 | -1 = 1;
  private failure: Error | null = null;
  private idleWaiters: { resolve(): void; reject(e: Error): void }[] = [];

  private tracking = false;
  /** Entry time of each visible page not painted yet. */
  private readonly blankSince = new Map<number, number>();
  readonly blanks: Blank[] = [];
  readonly entered = new Set<number>();
  readonly renderMs: Record<Kind, number[]> = { preview: [], full: [] };
  /** Main-thread time to draw a bitmap into its page canvas. */
  readonly paintMs: Record<Kind, number[]> = { preview: [], full: [] };
  readonly bitmapSize: Partial<Record<Kind, string>> = {};
  droppedFull = 0;

  constructor(
    private readonly engine: SpikeEngine,
    private readonly doc: SpikeDoc,
    private readonly slots: number,
  ) {
    this.inFlight = Array.from({ length: slots }, () => null);
    Object.assign(this.scroller.style, { position: 'fixed', inset: '0', overflowY: 'scroll', background: '#e8eaed' });
    this.sizer.style.position = 'relative';
    this.scroller.append(this.sizer);
    document.body.append(this.scroller);

    const viewportWidth = this.scroller.clientWidth;
    const cssPerPt = (viewportWidth - 2 * PAGE_GAP) / Math.max(...doc.pages.map((p) => p.width));
    let top = PAGE_GAP;
    this.boxes = doc.pages.map((p) => {
      const width = p.width * cssPerPt;
      const box = { top, left: (viewportWidth - width) / 2, width, height: p.height * cssPerPt };
      top += box.height + PAGE_GAP;
      return box;
    });
    this.sizer.style.height = `${top}px`;
    this.fullScale = cssPerPt * devicePixelRatio;
    this.update();
  }

  get layout() {
    const b = this.boxes[0]!;
    return { viewport: `${this.scroller.clientWidth}×${this.scroller.clientHeight}`, page0Css: `${round1(b.width)}×${round1(b.height)}`, dpr: devicePixelRatio };
  }

  /** From now on, record when pages enter the viewport and how long they stay blank. */
  startTracking(): void {
    this.tracking = true;
  }

  /** Resolves once nothing is wanted and nothing is in flight; rejects if a render failed. */
  idle(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const settled = new Promise<void>((resolve, reject) => {
      this.idleWaiters.push({ resolve, reject });
      this.pump();
    });
    return withTimeout(settled, STEP_TIMEOUT_MS, 'render queue');
  }

  jumpTo(page: number): void {
    const box = this.boxes[page];
    if (!box) throw new Error(`page ${page} out of range (0–${this.boxes.length - 1})`);
    this.scroller.scrollTop = box.top;
    this.update();
  }

  /** Scrolls down by pxPerSec / 60 in every animation frame for `seconds`. */
  steady(pxPerSec: number, seconds: number) {
    const perFrame = pxPerSec / FRAMES_PER_SECOND;
    const fromTop = this.scroller.scrollTop;
    return new Promise<{ frames: number; ms: number; px: number; maxFrameGapMs: number }>((resolve, reject) => {
      let start: number | undefined;
      let previous = 0;
      let frames = 0;
      let maxFrameGapMs = 0;
      let position = fromTop;
      const frame = (now: number) => {
        if (this.failure) return reject(this.failure);
        if (start === undefined) start = now;
        else maxFrameGapMs = Math.max(maxFrameGapMs, now - previous);
        previous = now;
        if (now - start >= seconds * 1000) {
          return resolve({ frames, ms: Math.round(now - start), px: Math.round(this.scroller.scrollTop - fromTop), maxFrameGapMs: round1(maxFrameGapMs) });
        }
        position += perFrame;
        this.scroller.scrollTop = position;
        frames++;
        this.update();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  /** Ends the blank time of pages still visible and unpainted. */
  finish(): void {
    const now = performance.now();
    for (const [page, since] of this.blankSince) this.blanks.push({ page, ms: now - since, until: 'end' });
    this.blankSince.clear();
  }

  /** Mounts and unmounts pages for the current scroll position, records entries and exits, renders. */
  private update(): void {
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight;
    if (top !== this.lastTop) this.direction = top > this.lastTop ? 1 : -1;
    this.lastTop = top;

    const keep = this.range(top - MOUNT_SCREENS * height, top + height + MOUNT_SCREENS * height);
    for (const [page, m] of this.mounted) {
      if (inRange(page, keep)) continue;
      m.el.remove();
      this.mounted.delete(page);
    }
    for (let page = keep.first; page <= keep.last; page++) if (!this.mounted.has(page)) this.mount(page);

    const now = performance.now();
    const visible = this.range(top, top + height);
    if (this.tracking) {
      for (let page = visible.first; page <= visible.last; page++) {
        if (inRange(page, this.visible)) continue;
        this.entered.add(page);
        if (this.mounted.get(page)?.painted) this.blanks.push({ page, ms: 0, until: 'paint' });
        else this.blankSince.set(page, now);
      }
      for (let page = this.visible.first; page <= this.visible.last; page++) {
        const since = this.blankSince.get(page);
        if (inRange(page, visible) || since === undefined) continue;
        this.blankSince.delete(page);
        this.blanks.push({ page, ms: now - since, until: 'left' });
      }
    }
    this.visible = visible;
    this.pump();
  }

  /** Pages whose box intersects [y0, y1). */
  private range(y0: number, y1: number): Range {
    const b = this.boxes;
    let lo = 0;
    let hi = b.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (b[mid]!.top + b[mid]!.height <= y0) lo = mid + 1;
      else hi = mid;
    }
    let last = lo - 1;
    while (last + 1 < b.length && b[last + 1]!.top < y1) last++;
    return { first: lo, last };
  }

  private mount(page: number): void {
    const box = this.boxes[page]!;
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'absolute',
      top: `${box.top}px`,
      left: `${box.left}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      background: PLACEHOLDER,
    });
    this.sizer.append(el);
    this.mounted.set(page, { el, painted: null });
    const preview = this.previews.get(page);
    if (preview) {
      this.previews.delete(page); // most recently used
      this.previews.set(page, preview);
      this.paint(page, preview, 'preview');
    }
  }

  /**
   * Shows a bitmap in the page's box, stretched to it, in place of what was there. A preview is
   * copied into a small 2D canvas (the LRU keeps the bitmap). A full render is handed to a
   * `bitmaprenderer` canvas, which takes the bitmap without a copy on the main thread.
   */
  private paint(page: number, bitmap: ImageBitmap, kind: Kind): void {
    const m = this.mounted.get(page)!;
    const t0 = performance.now();
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', margin: '0', border: '0' });
    if (kind === 'preview') {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    } else {
      canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(bitmap);
    }
    m.el.replaceChildren(canvas);
    m.painted = kind;
    this.paintMs[kind].push(performance.now() - t0);
    const since = this.blankSince.get(page);
    if (since === undefined) return;
    this.blankSince.delete(page);
    this.blanks.push({ page, ms: performance.now() - since, until: 'paint' });
  }

  /** Render work wanted now, most urgent first. */
  private *wanted(): Generator<Job> {
    const { first, last } = this.visible;
    const step = this.direction;
    const visible = step > 0 ? seq(first, last - first + 1, 1) : seq(last, last - first + 1, -1);
    for (const page of visible) {
      if (!this.previews.has(page) && this.mounted.get(page)?.painted !== 'full') yield { page, kind: 'preview' };
    }
    for (const page of seq(step > 0 ? last + 1 : first - 1, PREVIEW_AHEAD, step)) {
      if (page >= 0 && page < this.boxes.length && !this.previews.has(page)) yield { page, kind: 'preview' };
    }
    for (const page of visible) if (this.mounted.get(page)?.painted !== 'full') yield { page, kind: 'full' };
  }

  /** Starts the most urgent wanted job on every idle worker; wakes idle() waiters when there is none. */
  private pump(): void {
    if (this.failure) return;
    for (let slot = 0; slot < this.slots; slot++) {
      if (this.inFlight[slot]) continue;
      for (const job of this.wanted()) {
        if (job.page % this.slots !== slot) continue;
        this.start(slot, job);
        break;
      }
    }
    if (this.inFlight.some(Boolean)) return;
    for (const w of this.idleWaiters.splice(0)) w.resolve();
  }

  private start(slot: number, job: Job): void {
    this.inFlight[slot] = job;
    const t0 = performance.now();
    this.engine.render(this.doc.docId, job.page, job.kind === 'preview' ? this.previewScale : this.fullScale).then(
      (bitmap) => {
        this.inFlight[slot] = null;
        this.renderMs[job.kind].push(performance.now() - t0);
        this.bitmapSize[job.kind] ??= `${bitmap.width}×${bitmap.height}`;
        const m = this.mounted.get(job.page);
        if (job.kind === 'preview') {
          this.cachePreview(job.page, bitmap);
          if (m && m.painted !== 'full') this.paint(job.page, bitmap, 'preview');
        } else {
          if (m) this.paint(job.page, bitmap, 'full');
          else this.droppedFull++;
          bitmap.close();
        }
        this.pump();
      },
      (err: unknown) => this.fail(err),
    );
  }

  private cachePreview(page: number, bitmap: ImageBitmap): void {
    this.previews.get(page)?.close();
    this.previews.delete(page);
    this.previews.set(page, bitmap);
    for (const [oldest, old] of this.previews) {
      if (this.previews.size <= PREVIEW_CACHE) break;
      this.previews.delete(oldest);
      old.close();
    }
  }

  private fail(err: unknown): void {
    this.failure ??= new Error(`render failed: ${err instanceof Error ? err.message : String(err)}`);
    for (const w of this.idleWaiters.splice(0)) w.reject(this.failure);
  }
}

export async function run(params: URLSearchParams) {
  const file = params.get('file');
  if (!file) throw new Error('missing ?file=');
  const workers = Number(params.get('workers') ?? 1);
  if (workers !== 1 && workers !== 2) throw new Error(`workers must be 1 or 2, not ${params.get('workers')}`);
  const pattern = params.get('pattern') ?? 'steady';

  const t0 = performance.now();
  const engine = await withTimeout(createFileWorkerEngine({ workers }), STEP_TIMEOUT_MS, 'engine start');
  const doc = await withTimeout(engine.open(file), STEP_TIMEOUT_MS, `open ${file}`);
  const openMs = Math.round(performance.now() - t0);
  const list = new PageList(engine, doc, workers);
  await list.idle(); // the first screen and the previews around it

  list.startTracking();
  const longTasks: number[] = [];
  const longTaskObserver = new PerformanceObserver((entries) => longTasks.push(...entries.getEntries().map((e) => e.duration)));
  longTaskObserver.observe({ type: 'longtask' });
  let scroll: Awaited<ReturnType<PageList['steady']>> | null = null;
  if (pattern === 'steady') {
    scroll = await list.steady(Number(params.get('pxPerSec') ?? 3000), Number(params.get('seconds') ?? 20));
  } else if (pattern === 'jump') {
    for (const target of (params.get('targets') ?? '').split(',').map(Number)) {
      await list.idle(); // each jump starts from a settled screen
      list.jumpTo(target);
    }
  } else {
    throw new Error(`unknown pattern "${pattern}"`);
  }
  await list.idle();
  list.finish();
  longTaskObserver.disconnect();

  const blankMs = list.blanks.map((b) => b.ms);
  const worst = list.blanks.reduce<Blank | null>((w, b) => (b.ms > (w?.ms ?? 0) ? b : w), null); // null when no page was blank
  return {
    maxBlankMs: percentile(blankMs, 1),
    p50BlankMs: percentile(blankMs, 0.5),
    p95BlankMs: percentile(blankMs, 0.95),
    pagesEntered: list.entered.size,
    pagesOverBudget: list.blanks.filter((b) => b.ms > 150).length,
    worstPage: worst?.page ?? null,
    worstUntil: worst?.until ?? null,
    workers,
    pattern,
    pageCount: doc.pageCount,
    openMs,
    scroll: scroll && { ...scroll, pxPerSecAchieved: Math.round((scroll.px / scroll.ms) * 1000) },
    blanks: list.blanks.map((b) => ({ ...b, ms: round1(b.ms) })),
    renderMs: { preview: stats(list.renderMs.preview), full: stats(list.renderMs.full) },
    paintMs: { preview: stats(list.paintMs.preview), full: stats(list.paintMs.full) },
    longTasks: stats(longTasks),
    bitmapSize: list.bitmapSize,
    droppedFull: list.droppedFull,
    layout: list.layout,
  };
}
