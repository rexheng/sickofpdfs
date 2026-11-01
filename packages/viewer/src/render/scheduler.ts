// One render queue per tab, in front of PdfBackend.renderTile. The page list and the thumbnail rail (Task 24) share it
// and its preview cache. The rail's previews are idle work (requestIdlePreview): they never hold up the page list.
//
// Rendering is pulled, not pushed (Phase 0, P0-3): at most `concurrency` calls are with the engine at once, and
// everything else waits here, where it can still be re-prioritised or dropped. So work for a page the reader has
// scrolled past is never started, and a jump waits for at most the one call in flight.
//
// Previews are drawn upright (the page's own /Rotate only) and turned by whoever paints them (Task 26): the view's
// rotation then never empties the preview cache, and turning a 600-page book redraws only the pages in view.
import type { DocHandle, PdfBackend, PdfRect, Rotation } from '../backend/types';

export type RenderKind = 'preview' | 'full';

export interface RenderSchedulerOptions {
  /** Calls in flight at once: ENGINE_WORKERS. */
  concurrency: 1 | 2;
  /** Previews are this many device px wide (callers pass the matching scale). */
  previewWidthPx: 160;
  /** Previews kept, least recently used dropped first. */
  previewCache: 300;
}

interface Job {
  key: string;
  pageIndex: number;
  kind: RenderKind;
  scale: number;
  rect: PdfRect | undefined;
  priority: number;
  seq: number;
  rotation: Rotation;
  promise: Promise<ImageBitmap>;
  resolve(b: ImageBitmap): void;
  reject(e: unknown): void;
  /** Callers' signals; the job is dropped when every one of them has fired. */
  signals: AbortSignal[];
  /** At least one caller passed no signal: only retain() (or, for a full render, a rotation change) drops it. */
  unsignalled: boolean;
  /** The caller no longer wants the result (a full render whose rotation changed, or every signal fired in flight). */
  dropped: boolean;
  /** Only idle callers want it (requestIdlePreview): it waits for the page list to be idle, and retain() keeps it. */
  idle: boolean;
}

/**
 * Idle previews start only once no full render has been asked for or drawn for this long: a scroll keeps asking for
 * full renders, so the rail waits until the reader stops.
 */
const IDLE_AFTER_FULL_MS = 150;

const abortError = () => new DOMException('The render was cancelled.', 'AbortError');

/**
 * Order: every preview before any full render; then lower `priority` first; then first come, first served. Idle
 * previews (requestIdlePreview) come after all of that.
 *
 * - `request` for the same page, kind, scale and rect as a queued or running job returns that job's promise and gives
 *   it the new priority, so callers re-request to re-prioritise.
 * - A preview resolves with the cached bitmap when there is one. Preview bitmaps belong to the cache: draw them, never
 *   close or transfer them. A full render's bitmap belongs to the caller.
 * - Dispatch runs on the next microtask, so requests made together are ordered together.
 */
export class RenderScheduler {
  private readonly queue: Job[] = [];
  private readonly running = new Map<string, Job>();
  /** Preview bitmaps by page; Map order is the LRU order (oldest first). */
  private readonly previews = new Map<number, ImageBitmap>();
  private viewRotation: Rotation = 0;
  private seq = 0;
  /** A running average of how long a full render takes (ms), from dispatch to bitmap. */
  private fullCost = 0;
  private pumpQueued = false;
  private disposed = false;
  /** When a full render was last asked for or finished (performance.now()). */
  private lastFullAt = -Infinity;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly backend: PdfBackend,
    private readonly doc: DocHandle,
    private readonly o: RenderSchedulerOptions,
  ) {}

  /** The width previews are drawn at, in device px. */
  get previewWidthPx(): number {
    return this.o.previewWidthPx;
  }

  /** How long a full render has been taking, in ms (a running average; 0 before the first). */
  get fullRenderMs(): number {
    return this.fullCost;
  }

  /** How many previews the cache keeps. */
  get previewCapacity(): number {
    return this.o.previewCache;
  }

  /**
   * A bitmap of page `pageIndex` (or of `rect`, unrotated page space) at `scale` device px per point. A full render is
   * drawn turned by the page's /Rotate plus the view rotation (setViewRotation); a preview by the page's /Rotate only,
   * upright, for the caller to turn as it paints it, so `scale` for a preview is per point of the upright page. Rejects
   * with an AbortError DOMException when the job is cancelled (retain, setViewRotation for a full render, `signal`).
   */
  request(pageIndex: number, kind: RenderKind, scale: number, priority: number, rect?: PdfRect, signal?: AbortSignal): Promise<ImageBitmap> {
    if (this.disposed) return Promise.reject(abortError());
    if (signal?.aborted) return Promise.reject(abortError());
    if (kind === 'full') this.lastFullAt = performance.now();
    return this.enqueue(pageIndex, kind, scale, priority, rect, signal, false);
  }

  /**
   * A preview of page `pageIndex` for the thumbnail rail: the same job, bitmap and cache as request(i, 'preview', scale,
   * …), so a preview either of them draws serves both. It never delays the page list: it waits behind every other job,
   * starts only when no full render is queued or drawing and none has been asked for in the last IDLE_AFTER_FULL_MS,
   * and with two engine workers only one idle preview draws at a time. retain() leaves it queued; `signal` cancels it.
   * When the page list asks for the same preview, the job becomes the page list's (and retain() applies to it again).
   */
  requestIdlePreview(pageIndex: number, scale: number, priority: number, signal: AbortSignal): Promise<ImageBitmap> {
    if (this.disposed || signal.aborted) return Promise.reject(abortError());
    return this.enqueue(pageIndex, 'preview', scale, priority, undefined, signal, true);
  }

  private enqueue(pageIndex: number, kind: RenderKind, scale: number, priority: number, rect: PdfRect | undefined, signal: AbortSignal | undefined, idle: boolean): Promise<ImageBitmap> {
    if (kind === 'preview' && rect === undefined) {
      const cached = this.previews.get(pageIndex);
      if (cached) {
        this.previews.delete(pageIndex); // most recently used
        this.previews.set(pageIndex, cached);
        return Promise.resolve(cached);
      }
    }
    const rotation = kind === 'preview' ? 0 : this.viewRotation;
    const key = jobKey(pageIndex, kind, scale, rect, rotation);
    const existing = this.running.get(key) ?? this.queue.find((j) => j.key === key);
    if (existing) {
      // A page-list caller makes an idle job its own; an idle caller only re-prioritises a job that is still idle.
      if (!idle || existing.idle) existing.priority = priority;
      if (!idle) existing.idle = false;
      this.watch(existing, signal);
      this.schedulePump();
      return existing.promise;
    }
    let resolve!: (b: ImageBitmap) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<ImageBitmap>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: Job = {
      key,
      pageIndex,
      kind,
      scale,
      rect,
      priority,
      seq: this.seq++,
      rotation,
      promise,
      resolve,
      reject,
      signals: [],
      unsignalled: false,
      dropped: false,
      idle,
    };
    this.watch(job, signal);
    this.queue.push(job);
    this.schedulePump();
    return promise;
  }

  /**
   * Cancels queued work for pages outside [first, last] (each rejects with AbortError). Running work finishes, and idle
   * previews (requestIdlePreview) stay queued.
   */
  retain(range: { first: number; last: number }): void {
    this.cancelQueued((j) => !j.idle && (j.pageIndex < range.first || j.pageIndex > range.last));
  }

  /** The preview of `pageIndex` if it is cached, without queueing anything (for drawing in the same frame). */
  cachedPreview(pageIndex: number): ImageBitmap | null {
    return this.previews.get(pageIndex) ?? null;
  }

  /**
   * The view rotation every later full render is drawn with. Changing it cancels the full renders queued and drops the
   * one drawing; previews are upright, so the cache and the previews queued stay.
   */
  setViewRotation(rotation: Rotation): void {
    if (rotation === this.viewRotation) return;
    this.viewRotation = rotation;
    this.cancelQueued((j) => j.kind === 'full');
    for (const job of this.running.values()) if (job.kind === 'full') job.dropped = true;
  }

  /** Cancels everything and frees the cached previews. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    this.cancelQueued(() => true);
    for (const job of this.running.values()) job.dropped = true;
    this.clearPreviews();
  }

  private watch(job: Job, signal: AbortSignal | undefined): void {
    if (!signal) {
      job.unsignalled = true;
      return;
    }
    if (job.signals.includes(signal)) return;
    job.signals.push(signal);
    signal.addEventListener(
      'abort',
      () => {
        if (job.unsignalled || !job.signals.every((s) => s.aborted)) return;
        const at = this.queue.indexOf(job);
        if (at >= 0) {
          this.queue.splice(at, 1);
          job.reject(abortError());
        } else if (this.running.get(job.key) === job) {
          job.dropped = true;
        }
      },
      { once: true },
    );
  }

  private cancelQueued(match: (j: Job) => boolean): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const job = this.queue[i];
      if (!match(job)) continue;
      this.queue.splice(i, 1);
      job.reject(abortError());
    }
  }

  private clearPreviews(): void {
    for (const bitmap of this.previews.values()) bitmap.close();
    this.previews.clear();
  }

  private schedulePump(): void {
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  private pump(): void {
    while (!this.disposed && this.running.size < this.o.concurrency && this.queue.length > 0) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (before(this.queue[i], this.queue[best])) best = i;
      // Idle jobs sort last, so the best is idle only when nothing else is waiting.
      if (this.queue[best].idle && !this.idleNow()) return;
      const job = this.queue.splice(best, 1)[0];
      this.start(job);
    }
  }

  /** Whether an idle preview may start now; if not, a pump is set for when it may. */
  private idleNow(): boolean {
    for (const job of this.running.values()) if (job.kind === 'full' || job.idle) return false; // finish() pumps again
    const wait = this.lastFullAt + IDLE_AFTER_FULL_MS - performance.now();
    if (wait <= 0) return true;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.pump(), Math.ceil(wait));
    return false;
  }

  private start(job: Job): void {
    this.running.set(job.key, job);
    const startedAt = performance.now();
    this.backend
      .renderTile(this.doc, { pageIndex: job.pageIndex, scale: job.scale, rect: job.rect, viewRotation: job.rotation, withAnnotations: true })
      .then(
        (bitmap) => {
          this.finish(job);
          if (job.kind === 'full') {
            const ms = performance.now() - startedAt;
            this.fullCost = this.fullCost === 0 ? ms : 0.7 * this.fullCost + 0.3 * ms;
          }
          if (job.kind === 'preview' && job.rect === undefined && !this.disposed) {
            this.cachePreview(job.pageIndex, bitmap);
            if (job.dropped) job.reject(abortError());
            else job.resolve(bitmap);
            return;
          }
          if (job.dropped || this.disposed) {
            bitmap.close();
            job.reject(abortError());
          } else {
            job.resolve(bitmap);
          }
        },
        (err: unknown) => {
          this.finish(job);
          job.reject(err);
        },
      );
  }

  private finish(job: Job): void {
    if (this.running.get(job.key) === job) this.running.delete(job.key);
    if (job.kind === 'full') this.lastFullAt = performance.now();
    this.pump();
  }

  private cachePreview(pageIndex: number, bitmap: ImageBitmap): void {
    const old = this.previews.get(pageIndex);
    if (old && old !== bitmap) old.close();
    this.previews.delete(pageIndex);
    this.previews.set(pageIndex, bitmap);
    for (const [oldest, b] of this.previews) {
      if (this.previews.size <= this.o.previewCache) break;
      this.previews.delete(oldest);
      b.close();
    }
  }
}

function jobKey(pageIndex: number, kind: RenderKind, scale: number, rect: PdfRect | undefined, rotation: Rotation): string {
  const r = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : '';
  return `${pageIndex}|${kind}|${scale}|${rotation}|${r}`;
}

/** Whether `a` goes before `b`: idle previews last; then previews first, then priority, then arrival. */
function before(a: Job, b: Job): boolean {
  if (a.idle !== b.idle) return b.idle;
  if (a.kind !== b.kind) return a.kind === 'preview';
  if (a.priority !== b.priority) return a.priority < b.priority;
  return a.seq < b.seq;
}
