// P0-10: PDFium page objects, the structure tree and text runs, and figure finding from them, in our engine worker.
//   spike.html?check=objects&file=<url>&page=<index>[&detect=1][&textRuns=1]
//     → { pageIndex, renderMs, objects, truncated, elapsedMs, objectCount, struct, missingFunctions, [runs], [figures, detectMs, …] }.
//       The page is drawn first, as the viewer draws a page before it looks for figures, so PDFium has it loaded;
//       then getPageObjects (recurseForms, 20,000 objects, 15 ms) and getStructTree, plus getPageTextRuns with
//       `textRuns` and detectFigures with `detect`.
//   spike.html?check=objects&papers=<url,…>&names=<name,…>&pages=<n>
//     → for the first n pages of each paper: draw the page, call detectFigures once (its text page is not loaded
//       yet: `firstMs`), then again (`ms`: the page and its text page loaded, as after the page is drawn and its
//       text layer built). Returns one row per page and the p50 / p95 / max of `ms` and of `firstMs`.
// Every time is measured inside the worker (`elapsedMs` of the engine call); `roundTripMs` adds the message round trip.
import { createFileWorkerEngine, type SpikeEngine } from '../engine/client';
import type { DetectFiguresResult, PageObjectsResult, StructElement, TextRun } from '../engine/spike-native';
import { withTimeout } from './render';

const STEP_TIMEOUT_MS = 20_000;
/** The production limits (06 §3.2): stop at 20,000 objects or 15 ms. */
const OBJECT_OPTIONS = { recurseForms: true, maxObjects: 20_000, budgetMs: 15 };

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
/** Nearest-rank percentile. */
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? NaN;
};

async function timed<T>(what: string, call: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await withTimeout(call(), STEP_TIMEOUT_MS, what);
  return { value, ms: round(performance.now() - start) };
}

/** Draws the page at 1 px per point and throws the bitmap away: PDFium now has the page loaded, as in the viewer. */
async function draw(engine: SpikeEngine, docId: string, pageIndex: number): Promise<number> {
  const { value: bitmap, ms } = await timed(`render of page ${pageIndex}`, () => engine.render(docId, pageIndex, 1));
  bitmap.close();
  return ms;
}

async function onePage(engine: SpikeEngine, params: URLSearchParams) {
  const file = params.get('file');
  if (!file) throw new Error('objects check needs ?file=');
  const pageIndex = Number(params.get('page') ?? 0);
  const doc = await withTimeout(engine.open(file), STEP_TIMEOUT_MS, `open ${file}`);
  const renderMs = await draw(engine, doc.docId, pageIndex);
  const { value: list } = await timed('getPageObjects', () => engine.call<PageObjectsResult>('getPageObjects', doc.docId, pageIndex, OBJECT_OPTIONS));
  const { value: struct } = await timed('getStructTree', () => engine.call<StructElement[]>('getStructTree', doc.docId, pageIndex));
  // The PDFium functions the P0-10 methods call that this wasm does not export (expected: none).
  const missingFunctions = await engine.call<string[]>('missingObjectFunctions');
  const out: Record<string, unknown> = { pageIndex, renderMs, ...list, objectCount: list.objects.length, struct, missingFunctions };
  if (params.get('textRuns') === '1') {
    out.runs = (await timed('getPageTextRuns', () => engine.call<TextRun[]>('getPageTextRuns', doc.docId, pageIndex))).value;
  }
  if (params.get('detect') === '1') {
    const { value: d, ms } = await timed('detectFigures', () => engine.call<DetectFiguresResult>('detectFigures', doc.docId, pageIndex));
    Object.assign(out, { figures: d.figures, detectMs: d.elapsedMs, detectRoundTripMs: ms, detectObjectCount: d.objectCount, detectPhases: d.phases });
  }
  await engine.close(doc.docId);
  return out;
}

async function papers(engine: SpikeEngine, params: URLSearchParams) {
  const urls = (params.get('papers') ?? '').split(',').filter(Boolean);
  const names = (params.get('names') ?? '').split(',');
  const pages = Number(params.get('pages') ?? 10);
  const rows = [];
  for (const [k, url] of urls.entries()) {
    const doc = await withTimeout(engine.open(url), STEP_TIMEOUT_MS, `open ${url}`);
    for (let pageIndex = 0; pageIndex < Math.min(pages, doc.pageCount); pageIndex++) {
      const renderMs = await draw(engine, doc.docId, pageIndex);
      const first = await timed('detectFigures (first)', () => engine.call<DetectFiguresResult>('detectFigures', doc.docId, pageIndex));
      const warm = await timed('detectFigures', () => engine.call<DetectFiguresResult>('detectFigures', doc.docId, pageIndex));
      rows.push({
        name: names[k] ?? url,
        pageIndex,
        objectCount: warm.value.objectCount,
        truncated: warm.value.truncated,
        ms: warm.value.elapsedMs,
        firstMs: first.value.elapsedMs,
        roundTripMs: warm.ms,
        renderMs,
        phases: warm.value.phases,
        firstPhases: first.value.phases,
        figures: warm.value.figures.map((f) => ({ label: f.label, kind: f.kind, confidence: f.confidence, rect: f.rect, captionRect: f.captionRect })),
      });
    }
    await engine.close(doc.docId);
  }
  const ms = rows.map((r) => r.ms);
  const firstMs = rows.map((r) => r.firstMs);
  const figures = rows.flatMap((r) => r.figures);
  return {
    pages: rows,
    p50Ms: percentile(ms, 0.5),
    p95Ms: percentile(ms, 0.95),
    maxMs: Math.max(...ms),
    firstP50Ms: percentile(firstMs, 0.5),
    firstP95Ms: percentile(firstMs, 0.95),
    firstMaxMs: Math.max(...firstMs),
    figureCount: figures.length,
    captionedCount: figures.filter((f) => f.label !== null).length,
  };
}

export async function run(params: URLSearchParams) {
  const engine = await createFileWorkerEngine();
  return params.get('papers') ? papers(engine, params) : onePage(engine, params);
}
