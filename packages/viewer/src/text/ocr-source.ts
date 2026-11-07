// A scanned page's recognised text, merged into the page text everything reads (Phase 7.1, contracts §9). `withOcr` wraps the
// PDFium provider (page-text.ts, unchanged): a page with a recognised result answers from it, every other page from PDFium.
// So the text layer, selection painting, marks, anchoring, Find and Claude treat a scan like a text page.
//
// - `source(i)` is 'ocr:<engine>@<version>' for a recognised page, so anchors made on it record their textSource.
// - `rawText(i)` is the page's chars (OcrPageResult.text: U+FFFE kept where a line-end hyphen is joined), and `text(i)` is the
//   same without U+FFFE, exactly as getPageChars and getPageText are for a text page. Offsets into rawText are char indices.
// - `glyphs`, `rects` and `search` run on the word boxes (packages/core/src/ocr).
//
// The lookup decides which pages have results. It must answer a text page at once and never block it on recognition:
// a page waits only while it is not yet known whether a stored result exists for it (a saved scan, just reopened).
import { ocrPlainText, ocrRects, ocrSource, ocrText, ocrToPageGlyphs, searchOcr, type OcrPageResult } from '@sop/core';
import type { PageGlyphs, PdfRect, Rotation } from '../backend/types';
import { textModelRange, trimPageText } from '../text-layer/items';
import type { PageTextProviderImpl } from './page-text';

export interface OcrLookup {
  /** The page's recognised result as it is known now, or null: what `source()` reads (it cannot wait). */
  known(pageIndex: number): OcrPageResult | null;
  /** The page's result, once it is known whether there is one; null for a page PDFium reads. */
  page(pageIndex: number): Promise<OcrPageResult | null>;
  /** The page's /Rotate (a turned scan's words run at ocrAngle(rotation) in unrotated space). */
  rotation(pageIndex: number): Rotation;
}

/**
 * Where each word's chars meet on a recognised page, read from the page's own ink (R106, react/scan-ink-pages.ts): by
 * the word's first char index, the n − 1 places (page points along its text) between its n chars. Null while not read.
 */
export interface OcrRefine {
  cuts(pageIndex: number): ReadonlyMap<number, readonly number[]> | null;
}

/**
 * The recognised page's glyphs with each word's char boxes cut where its letters' ink meets (`cuts`), not where the
 * recogniser's letter widths guessed: so a selection or a mark starts and ends on whole letters. Only the boxes change
 * (never the text or the char indices), so every mark and comment stays on its words.
 */
export function refinedGlyphs(g: PageGlyphs, cuts: ReadonlyMap<number, readonly number[]>): PageGlyphs {
  const glyphs = g.glyphs.slice();
  const isChar = (k: number) => {
    const c = glyphs[k];
    return c !== undefined && !c.generated && c.box.width > 0 && c.box.height > 0;
  };
  for (let s = 0; s < glyphs.length; s++) {
    if (!isChar(s) || isChar(s - 1)) continue;
    let e = s + 1;
    while (isChar(e)) e++;
    const at = cuts.get(s);
    if (at === undefined || at.length !== e - s - 1) continue;
    const first = glyphs[s];
    const angle = first.angle;
    const turned = angle === 90 || angle === 270;
    const back = angle === 180 || angle === 270;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = s; k < e; k++) {
      const b = glyphs[k].box;
      lo = Math.min(lo, turned ? b.y : b.x);
      hi = Math.max(hi, turned ? b.y + b.height : b.x + b.width);
    }
    // The places in reading order: the edges are the word's own, the cuts are clamped inside it and kept in order.
    const edges = [back ? hi : lo, ...at.map((c) => Math.min(hi, Math.max(lo, c))), back ? lo : hi];
    for (let k = 1; k < edges.length; k++) edges[k] = back ? Math.min(edges[k], edges[k - 1]) : Math.max(edges[k], edges[k - 1]);
    for (let k = s; k < e; k++) {
      const a = edges[k - s];
      const b = edges[k - s + 1];
      const from = Math.min(a, b);
      const size = Math.abs(b - a);
      const box = glyphs[k].box;
      const next = turned ? { ...box, y: from, height: size } : { ...box, x: from, width: size };
      glyphs[k] = { ...glyphs[k], box: next, tight: next };
    }
  }
  return { ...g, glyphs };
}

/** Merged line rects of chars [start, start + count) from glyphs (one rect a line, `runs`), as ocrRects makes them. */
function rectsOf(g: PageGlyphs, start: number, count: number): PdfRect[] {
  const end = start + Math.max(0, count);
  const out: PdfRect[] = [];
  for (const line of g.runs) {
    const from = Math.max(start, line.start);
    const to = Math.min(end, line.end);
    if (from >= to) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = from; i < to; i++) {
      const c = g.glyphs[i];
      const b = c.box;
      if (c.generated || b.width <= 0 || b.height <= 0) continue;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width);
      y1 = Math.max(y1, b.y + b.height);
    }
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return out;
}

export function withOcr(base: PageTextProviderImpl, lookup: OcrLookup, refine?: OcrRefine): PageTextProviderImpl {
  const on = async <T>(i: number, ocr: (r: OcrPageResult, rotation: Rotation) => T, pdfium: () => Promise<T>): Promise<T> => {
    const r = await lookup.page(i);
    return r === null ? pdfium() : ocr(r, lookup.rotation(i));
  };
  // The refined glyphs, made once for each page's glyphs and cuts.
  const made = new WeakMap<PageGlyphs, { cuts: ReadonlyMap<number, readonly number[]>; glyphs: PageGlyphs }>();
  const glyphsOf = (r: OcrPageResult, rotation: Rotation): PageGlyphs => {
    const raw = ocrToPageGlyphs(r, { rotation });
    const cuts = refine?.cuts(r.pageIndex) ?? null;
    if (cuts === null) return raw;
    const hit = made.get(raw);
    if (hit?.cuts === cuts) return hit.glyphs;
    const glyphs = refinedGlyphs(raw, cuts);
    made.set(raw, { cuts, glyphs });
    return glyphs;
  };
  return {
    source: (i) => {
      const r = lookup.known(i);
      return r === null ? base.source(i) : ocrSource(r);
    },
    text: (i) => on(i, (r, rot) => ocrPlainText(ocrText(r.words, rot)), () => base.text(i)),
    rawText: (i) => on(i, (r, rot) => ocrText(r.words, rot), () => base.rawText(i)),
    glyphs: (i) => on(i, (r, rotation) => glyphsOf(r, rotation), () => base.glyphs(i)),
    rects: (i, start, count) => on(i, (r, rot) => (refine?.cuts(r.pageIndex) ? rectsOf(glyphsOf(r, rot), start, count) : ocrRects(r, start, count, rot)), () => base.rects(i, start, count)),
    rangeText: (i, start, count) => on(i, (r, rot) => ocrPlainText(ocrText(r.words, rot).slice(start, start + count)), () => base.rangeText(i, start, count)),
    search: (i, query, o) => on(i, (r, rot) => searchOcr(r, query, o, rot), () => base.search(i, query, o)),
    copyText: (i) =>
      on(
        i,
        (r, rotation) => {
          const g = glyphsOf(r, rotation);
          return { text: trimPageText(textModelRange(g, 0, g.glyphs.length)), charCount: g.glyphs.length };
        },
        () => base.copyText(i),
      ),
    clear: () => base.clear(),
  };
}
