// Spec-blind tests for the render scheduler's queue rules (Task 21), in a browser because the engine hands back real ImageBitmaps.
// Interface file: RenderScheduler(backend, doc, { concurrency: 1 | 2, previewWidthPx: 160, previewCache: 300 }), one per tab, shared by the
// page list and the thumbnail rail "so that there is one queue and one preview cache"; request(pageIndex, kind, scale, priority, rect?) resolves
// with an ImageBitmap; retain({ first, last }) "cancels queued work outside the range (rejects with AbortError)"; ENGINE_WORKERS = 1;
// R24: "a jump during a full render stays within 150 ms" (so a jump must not wait behind renders nobody can see any more).
// The backend here is a stand-in that holds every render until the test lets it go: the scheduler is the thing under test.
import { describe, expect, it } from 'vitest';
import type { DocHandle, PdfBackend, TileRequest } from '../backend/types';
import { RenderScheduler } from './scheduler';

interface Held {
  req: TileRequest;
  signal: AbortSignal | undefined;
  release(): Promise<void>;
}

function heldBackend() {
  const calls: Held[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const backend = {
    renderTile(_doc: DocHandle, req: TileRequest, signal?: AbortSignal): Promise<ImageBitmap> {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<ImageBitmap>((resolve, reject) => {
        const finish = async () => {
          inFlight--;
          resolve(await createImageBitmap(new ImageData(20, 30)));
        };
        const held: Held = { req, signal, release: finish };
        calls.push(held);
        signal?.addEventListener('abort', () => {
          inFlight--;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    },
  } as unknown as PdfBackend;
  return { backend, calls, maxInFlight: () => maxInFlight };
}

const DOC = 'doc-1' as DocHandle;
const OPTS = { concurrency: 1 as const, previewWidthPx: 160 as const, previewCache: 300 as const };
const settle = async (p: Promise<unknown>) => (await Promise.allSettled([p]))[0];
const pagesCalled = (calls: Held[]) => calls.map((c) => c.req.pageIndex);

describe('RenderScheduler', () => {
  it('with concurrency 1, only one render is in the engine at a time, and every request is answered with a bitmap', async () => {
    const { backend, calls, maxInFlight } = heldBackend();
    const s = new RenderScheduler(backend, DOC, OPTS);
    const results = [0, 1, 2].map((i) => s.request(i, 'full', 1.5, 0));
    await expect.poll(() => calls.length).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length, 'the other two wait their turn').toBe(1);
    for (let n = 0; n < 3; n++) {
      await expect.poll(() => calls.length, { timeout: 2_000 }).toBeGreaterThan(n);
      await calls[n].release();
    }
    const bitmaps = await Promise.all(results);
    expect(bitmaps.every((b) => b.width === 20 && b.height === 30)).toBe(true);
    expect(maxInFlight()).toBe(1);
    expect(new Set(pagesCalled(calls))).toEqual(new Set([0, 1, 2]));
  });

  it('retain() drops queued renders outside the range with an AbortError, and they never reach the engine', async () => {
    const { backend, calls } = heldBackend();
    const s = new RenderScheduler(backend, DOC, OPTS);
    const first = s.request(10, 'full', 1, 0);
    await expect.poll(() => calls.length).toBe(1); // page 10 is in the engine
    const queued = [11, 12, 13].map((i) => s.request(i, 'full', 1, 0));
    s.retain({ first: 40, last: 42 }); // the reader jumped far away
    const outcomes = await Promise.all(queued.map(settle));
    for (const o of outcomes) {
      expect(o.status).toBe('rejected');
      expect((o as PromiseRejectedResult).reason).toMatchObject({ name: 'AbortError' });
    }
    await calls[0].release().catch(() => {});
    await settle(first);
    expect(pagesCalled(calls), 'no render was started for a page that was no longer wanted').toEqual([10]);
  });

  it('retain() keeps queued renders inside the range, and a request made after it for a page in the range runs', async () => {
    const { backend, calls } = heldBackend();
    const s = new RenderScheduler(backend, DOC, OPTS);
    const busy = s.request(0, 'full', 1, 0);
    await expect.poll(() => calls.length).toBe(1);
    const keep = s.request(5, 'full', 1, 0);
    const drop = s.request(6, 'full', 1, 0);
    s.retain({ first: 5, last: 5 });
    expect((await settle(drop)).status).toBe('rejected');
    await calls[0].release().catch(() => {});
    await settle(busy);
    await expect.poll(() => calls.length, { timeout: 2_000 }).toBe(2);
    expect(pagesCalled(calls)[1]).toBe(5);
    await calls[1].release();
    expect((await keep).width).toBe(20);
  });

  it('a preview of a page is made once: asking again (the page list, then the thumbnail rail) is answered from the shared cache', async () => {
    const { backend, calls } = heldBackend();
    const s = new RenderScheduler(backend, DOC, OPTS);
    const a = s.request(3, 'preview', 0.26, 0);
    await expect.poll(() => calls.length).toBe(1);
    await calls[0].release();
    await a;
    const b = await s.request(3, 'preview', 0.26, 0);
    expect(b.width).toBeGreaterThan(0);
    expect(calls.length, 'the second preview did not go back to the engine').toBe(1);
  });
});
