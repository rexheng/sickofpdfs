// One render queue per tab, in front of PdfBackend.renderTile. The page list and the thumbnail rail (Task 24) share it
// and its preview cache.
//
// Rendering is pulled, not pushed (Phase 0, P0-3): at most `concurrency` calls are with the engine at once, and
// everything else waits here, where it can still be re-prioritised or dropped. So work for a page the reader has
// scrolled past is never started, and a jump waits for at most the one call in flight.
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
  /** At least one caller passed no signal: only retain() or a rotation change drops it. */
  unsignalled: boolean;
  /** The caller no longer wants the result (rotation changed or every signal fired while it was in flight). */
  dropped: boolean;
}

const abortError = () => new DOMException('The render was cancelled.', 'AbortError');

/**
 * Order: every preview before any full render; then lower `priority` first; then first come, first served.
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
   * A bitmap of page `pageIndex` (or of `rect`, unrotated page space) at `scale` device px per point, drawn turned by
   * the page's /Rotate plus the view rotation (setViewRotation). Rejects with an AbortError DOMException when the job
   * is cancelled (retain, setViewRotation, `signal`).
   */
  request(pageIndex: number, kind: RenderKind, scale: number, priority: number, rect?: PdfRect, signal?: AbortSignal): Promise<ImageBitmap> {
    if (this.disposed) return Promise.reject(abortError());
    if (signal?.aborted) return Promise.reject(abortError());
    if (kind === 'preview' && rect === undefined) {
      const cached = this.previews.get(pageIndex);
      if (cached) {
        this.previews.delete(pageIndex); // most recently used
        this.previews.set(pageIndex, cached);
        return Promise.resolve(cached);
      }
    }
    const key = jobKey(pageIndex, kind, scale, rect);
    const existing = this.running.get(key) ?? this.queue.find((j) => j.key === key);
    if (existing) {
      existing.priority = priority;
      this.watch(existing, signal);
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
      rotation: this.viewRotation,
      promise,
      resolve,
      reject,
      signals: [],
      unsignalled: false,
      dropped: false,
    };
    this.watch(job, signal);
    this.queue.push(job);
    this.schedulePump();
    return promise;
  }

  /** Cancels queued work for pages outside [first, last] (each rejects with AbortError). Running work finishes. */
  retain(range: { first: number; last: number }): void {
    this.cancelQueued((j) => j.pageIndex < range.first || j.pageIndex > range.last);
  }

  /** The preview of `pageIndex` if it is cached, without queueing anything (for drawing in the same frame). */
  cachedPreview(pageIndex: number): ImageBitmap | null {
    return this.previews.get(pageIndex) ?? null;
  }

  /** The view rotation every later render is drawn with. Changing it empties the preview cache and cancels the queue. */
  setViewRotation(rotation: Rotation): void {
    if (rotation === this.viewRotation) return;
    this.viewRotation = rotation;
    this.clearPreviews();
    this.cancelQueued(() => true);
    for (const job of this.running.values()) job.dropped = true;
  }

  /** Cancels everything and frees the cached previews. */
  dispose(): void {
    this.disposed = true;
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
      const job = this.queue.splice(best, 1)[0];
      this.start(job);
    }
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
          if (job.kind === 'preview' && job.rect === undefined && job.rotation === this.viewRotation && !this.disposed) {
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

function jobKey(pageIndex: number, kind: RenderKind, scale: number, rect: PdfRect | undefined): string {
  const r = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : '';
  return `${pageIndex}|${kind}|${scale}|${r}`;
}

/** Whether `a` goes before `b`: previews first, then priority, then arrival. */
function before(a: Job, b: Job): boolean {
  if (a.kind !== b.kind) return a.kind === 'preview';
  if (a.priority !== b.priority) return a.priority < b.priority;
  return a.seq < b.seq;
}
