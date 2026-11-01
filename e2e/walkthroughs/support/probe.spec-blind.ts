// A probe that runs INSIDE the viewer page (added with context.addInitScript before the page loads). It watches
// the page canvases the way a person's eye does: a page is "blank" from the moment its place scrolls into view until
// its picture is on it. It uses only the DOM contract (a `[role=document]` scroller holding `<canvas>` elements)
// and the published page boxes (`__sopTest.viewer.pageBoxes()`), and it reads the page numbers from the strips of
// book-400 (see fixtures.spec-blind.ts), so it can tell a blank page from a wrong one.
//
// installProbe is serialised by Playwright, so it must not refer to anything outside its own body.
import type { BAR } from './fixtures.spec-blind';

export type BarGeometry = typeof BAR;

export interface BlankRecord {
  page: number;
  /** Milliseconds from the page coming into view to its picture showing. */
  ms: number;
  /** The page scrolled out of view before it was painted. */
  left: boolean;
  /** Still unpainted when the probe was stopped. */
  pending: boolean;
}

export interface BlankReport {
  records: BlankRecord[];
  /** A canvas in page n's place showed page m's number. */
  wrong: { page: number; got: number }[];
  frames: number;
  /** The longest gap between two animation frames while the probe ran (a starved machine shows up here). */
  maxFrameGapMs: number;
  maxMs: number;
  p95Ms: number;
  pagesSeen: number;
}

export interface CanvasRead {
  /** The page the canvas sits at, by the published page boxes. */
  page: number;
  state: 'empty' | 'blank' | 'page' | 'other';
  /** The page number its strip shows (state 'page' only). */
  n: number;
  /** The canvas's place on screen, CSS px from the window's top-left. */
  x: number;
  y: number;
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
}

export interface Probe {
  /** performance.now() (ms since this page's navigation began) when any visible canvas first showed ink; null until then. */
  firstInkAt: number | null;
  inkNow(): Promise<boolean>;
  readCanvases(): Promise<CanvasRead[]>;
  startBlank(): void;
  stopBlank(): Promise<BlankReport>;
  /** Scrolls the document scroller by pxPerSec / 60 on every animation frame for `seconds`. */
  steady(pxPerSec: number, seconds: number): Promise<{ from: number; to: number; frames: number; ms: number }>;
  /** Every key pressed in the page, with performance.now() at the time. */
  keys: { key: string; at: number }[];
}

export function installProbe(bar: BarGeometry): void {
  if (location.protocol !== 'chrome-extension:') return;

  type Box = { index: number; top: number; left: number; width: number; height: number };
  type Hooks = { viewer?: { pageBoxes(): Box[] } };
  const hooks = (): Hooks | undefined => (globalThis as unknown as { __sopTest?: Hooks }).__sopTest;
  const scroller = () => document.querySelector<HTMLElement>('[role="document"]');
  const canvases = () => Array.from(document.querySelectorAll<HTMLCanvasElement>('[role="document"] canvas'));
  const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

  async function readStrip(c: HTMLCanvasElement): Promise<{ state: CanvasRead['state']; n: number }> {
    const w = c.width;
    const h = c.height;
    if (w < 16 || h < 16) return { state: 'empty', n: 0 };
    const sx = Math.floor((w * bar.x0) / bar.pageWidth);
    const sw = Math.max(bar.squares, Math.round((w * bar.squares * bar.size) / bar.pageWidth));
    const sy = Math.floor((h * (bar.tops[0] + 4)) / bar.pageHeight);
    const sh = Math.max(2, Math.round((h * (bar.size - 8)) / bar.pageHeight));
    const bmp = await createImageBitmap(c, sx, sy, sw, sh, { resizeWidth: bar.squares * 4, resizeHeight: 4, resizeQuality: 'medium' });
    const oc = new OffscreenCanvas(bar.squares * 4, 4);
    const ctx = oc.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { state: 'other', n: 0 };
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const px = ctx.getImageData(0, 0, bar.squares * 4, 4).data;
    const cells: { a: number; l: number }[] = [];
    for (let i = 0; i < bar.squares; i++) {
      const o = (1 * bar.squares * 4 + i * 4 + 2) * 4;
      cells.push({ a: px[o + 3] ?? 0, l: lum(px[o] ?? 0, px[o + 1] ?? 0, px[o + 2] ?? 0) });
    }
    if (cells.every((c2) => c2.a < 128)) return { state: 'empty', n: 0 };
    if (cells.some((c2) => c2.a < 200)) return { state: 'other', n: 0 };
    const first = cells[0];
    const last = cells[bar.squares - 1];
    if (first && last && first.l < 80 && last.l < 80 && cells.every((c2) => c2.l < 80 || c2.l > 150)) {
      return { state: 'page', n: cells.slice(1, 10).reduce((n, c2) => n * 2 + (c2.l < 80 ? 1 : 0), 0) };
    }
    if (cells.every((c2) => c2.l > 150)) return { state: 'blank', n: 0 };
    return { state: 'other', n: 0 };
  }

  /** Any pixel that is opaque and not white, in a 64 x 64 look at the canvas. */
  async function hasInk(c: HTMLCanvasElement): Promise<boolean> {
    if (c.width < 16 || c.height < 16) return false;
    const bmp = await createImageBitmap(c, { resizeWidth: 64, resizeHeight: 64, resizeQuality: 'medium' });
    const oc = new OffscreenCanvas(64, 64);
    const ctx = oc.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const px = ctx.getImageData(0, 0, 64, 64).data;
    for (let i = 0; i < px.length; i += 4) if ((px[i + 3] ?? 0) > 200 && lum(px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0) < 240) return true;
    return false;
  }

  const inView = (c: HTMLCanvasElement) => {
    const s = scroller();
    if (!s) return false;
    const r = c.getBoundingClientRect();
    const v = s.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > v.top + 4 && r.top < v.bottom - 4 && r.right > v.left + 4 && r.left < v.right - 4;
  };

  /** The page whose box holds the canvas's centre, in the scroller's content coordinates. */
  const pageOf = (c: HTMLCanvasElement, boxes: Box[]): number => {
    const s = scroller();
    if (!s) return -1;
    const r = c.getBoundingClientRect();
    const v = s.getBoundingClientRect();
    const cy = r.top + r.height / 2 - (v.top - s.scrollTop);
    const cx = r.left + r.width / 2 - (v.left - s.scrollLeft);
    let best = -1;
    let bestDist = Infinity;
    for (const b of boxes) {
      const d = Math.abs(b.top + b.height / 2 - cy) + Math.abs(b.left + b.width / 2 - cx) * 0.01;
      if (d < bestDist) {
        bestDist = d;
        best = b.index;
      }
    }
    return best;
  };

  const probe: Probe = {
    firstInkAt: null,
    keys: [],

    async inkNow() {
      for (const c of canvases()) if (inView(c) && (await hasInk(c))) return true;
      return false;
    },

    async readCanvases() {
      const boxes = hooks()?.viewer?.pageBoxes() ?? [];
      const out: CanvasRead[] = [];
      for (const c of canvases()) {
        // A page also holds a hidden preview canvas under its full render; only what is shown counts.
        if (!inView(c) || getComputedStyle(c).visibility === 'hidden') continue;
        const r = c.getBoundingClientRect();
        const read = await readStrip(c);
        out.push({ page: pageOf(c, boxes), ...read, x: r.left, y: r.top, cssWidth: r.width, cssHeight: r.height, backingWidth: c.width, backingHeight: c.height });
      }
      return out;
    },

    startBlank() {
      const s = scroller();
      const boxes = hooks()?.viewer?.pageBoxes();
      if (!s || !boxes) throw new Error('startBlank: the viewer has no scroller or no page boxes yet');
      const open = new Map<number, { t0: number; painted: boolean }>();
      const records: BlankRecord[] = [];
      const wrong: { page: number; got: number }[] = [];
      const pending = new WeakSet<HTMLCanvasElement>();
      let frames = 0;
      let last = performance.now();
      let maxGap = 0;
      const seen = new Set<number>();
      const state = { running: true };
      const frame = (now: number) => {
        if (!state.running) return;
        frames++;
        maxGap = Math.max(maxGap, now - last);
        last = now;
        const top = s.scrollTop;
        const vh = s.clientHeight;
        const visible = new Set<number>();
        for (const b of boxes) if (b.top + b.height > top + 8 && b.top < top + vh - 8) visible.add(b.index);
        for (const p of visible) {
          seen.add(p);
          if (!open.has(p)) open.set(p, { t0: now, painted: false });
        }
        for (const [p, rec] of open) {
          if (visible.has(p)) continue;
          if (!rec.painted) records.push({ page: p, ms: now - rec.t0, left: true, pending: false });
          open.delete(p);
        }
        for (const c of canvases()) {
          if (!inView(c) || pending.has(c)) continue;
          const page = pageOf(c, boxes);
          pending.add(c);
          const started = performance.now();
          void readStrip(c).then((res) => {
            pending.delete(c);
            if (res.state !== 'page') return;
            if (res.n !== page + 1) {
              wrong.push({ page, got: res.n });
              return;
            }
            const rec = open.get(page);
            if (rec && !rec.painted) {
              rec.painted = true;
              records.push({ page, ms: started - rec.t0, left: false, pending: false });
            }
          });
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      (probe as unknown as { _stop: () => Promise<BlankReport> })._stop = async () => {
        await new Promise((r) => setTimeout(r, 80)); // let the last reads land
        state.running = false;
        const now = performance.now();
        for (const [p, rec] of open) if (!rec.painted) records.push({ page: p, ms: now - rec.t0, left: false, pending: true });
        const ms = records.map((r) => r.ms).sort((a, b) => a - b);
        return {
          records,
          wrong,
          frames,
          maxFrameGapMs: maxGap,
          maxMs: ms.length > 0 ? (ms[ms.length - 1] ?? 0) : 0,
          p95Ms: ms.length > 0 ? (ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] ?? 0) : 0,
          pagesSeen: seen.size,
        };
      };
    },

    stopBlank() {
      const stop = (probe as unknown as { _stop?: () => Promise<BlankReport> })._stop;
      if (!stop) throw new Error('stopBlank without startBlank');
      return stop();
    },

    steady(pxPerSec, seconds) {
      const s = scroller();
      if (!s) throw new Error('steady: no scroller');
      const from = s.scrollTop;
      return new Promise((resolve) => {
        const t0 = performance.now();
        let frames = 0;
        const step = (now: number) => {
          frames++;
          if (now - t0 >= seconds * 1000) return resolve({ from, to: s.scrollTop, frames, ms: now - t0 });
          s.scrollTop += pxPerSec / 60;
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    },
  };

  window.addEventListener('keydown', (e) => probe.keys.push({ key: e.key, at: performance.now() }), true);
  (window as unknown as { __wt: Probe }).__wt = probe;

  // The first-paint clock: poll for the first canvas with ink from the very start of the page.
  let busy = false;
  const watch = () => {
    if (probe.firstInkAt !== null) return;
    if (!busy) {
      busy = true;
      const started = performance.now();
      void probe.inkNow().then((found) => {
        busy = false;
        if (found && probe.firstInkAt === null) probe.firstInkAt = started;
      });
    }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}
