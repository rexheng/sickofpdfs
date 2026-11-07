// D7.1: a PDF that is not saved has its scanned pages read in its tab's memory only. When the owner saves it (Save, or the first
// mark on a "not sure" scan), what the tab has read so far is written to the library then (`OcrService.adopt`), so a highlight
// made on recognised words is still on those words after a reload. Before the save nothing is written, and the store refuses
// (writes nothing) for a reading it does not hold.
import type { OcrPageResult } from '@sop/core';
import type { Rotation } from '@sop/viewer';
import type { OcrStore } from './service';

/** Writes each held page; answers how many the library kept. A page that fails is left for the background to read again. */
export async function writeHeldPages(store: Pick<OcrStore, 'putPageOcr'>, held: Iterable<OcrPageResult>, rotationOf: (pageIndex: number) => Rotation): Promise<number> {
  let kept = 0;
  for (const r of held) {
    try {
      if (await store.putPageOcr(r, { index: true, rotation: rotationOf(r.pageIndex) })) kept++;
    } catch {
      // read again later by the background service: nothing is lost but time
    }
  }
  return kept;
}
