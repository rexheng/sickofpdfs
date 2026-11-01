// P0-7: form-field detection in our engine worker.
//   spike.html?check=forms&file=<url>[&repeat=<n>]
//     → { formType, firstFillablePage, pagesWalked, widgetTypes, elapsedMs, pageCount, roundTripMs, missingFunctions, [leak] }.
//       The document is opened, then SpikeNative.getFormInfo runs on it. `elapsedMs` is measured inside the
//       worker around that one call (the open is not in it); `roundTripMs` adds the message round trip.
//       `missingFunctions` lists the PDFium functions getFormInfo calls that this wasm does not export (expected: none).
//       With `repeat`, getFormInfo runs n more times on the same document, and `leak` is the wasm heap's bytes in use
//       (heapInUse) before and after: a walk that left a widget, a page or a form-fill environment open would make it grow.
import { createFileWorkerEngine } from '../engine/client';
import type { FormInfo, FormWalk } from '../engine/spike-native';
import { withTimeout } from './render';

const STEP_TIMEOUT_MS = 20_000;
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

export async function run(params: URLSearchParams) {
  const file = params.get('file');
  if (!file) throw new Error('forms check needs ?file=');
  const engine = await createFileWorkerEngine();
  const doc = await withTimeout(engine.open(file), STEP_TIMEOUT_MS, `open ${file}`);
  const start = performance.now();
  const scan = await withTimeout(engine.call<FormInfo & FormWalk>('getFormInfo', doc.docId), STEP_TIMEOUT_MS, 'getFormInfo');
  const roundTripMs = round(performance.now() - start);
  const missingFunctions = await engine.call<string[]>('missingFormFunctions');
  const repeat = Number(params.get('repeat') ?? 0);
  let leak: { repeat: number; inUseBefore: number; inUseAfter: number } | undefined;
  if (repeat > 0) {
    const inUseBefore = await engine.call<number>('heapInUse'); // after the first call has made whatever PDFium keeps for the document
    for (let k = 0; k < repeat; k++) await withTimeout(engine.call('getFormInfo', doc.docId), STEP_TIMEOUT_MS, `getFormInfo #${k + 2}`);
    leak = { repeat, inUseBefore, inUseAfter: await engine.call<number>('heapInUse') };
  }
  await engine.close(doc.docId);
  return { ...scan, pageCount: doc.pageCount, roundTripMs, missingFunctions, ...(leak ? { leak } : {}) };
}
