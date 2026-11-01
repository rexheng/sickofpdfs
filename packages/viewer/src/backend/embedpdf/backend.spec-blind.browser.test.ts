// Spec-blind browser tests for the PdfBackend interface and its EmbedPDF (PDFium) implementation (Task 15).
// Written from the spec, the Phase 0 report and the interface file only. The expected values come from the fixture
// generators (pdf-lib, the Phase 0 scripts) and the classifier manifest, never from the engine.
//
// Needs, besides `pnpm fixtures`: the engine assets in apps/extension/public/pdf/ (`pnpm -C apps/extension assets`) and the
// Phase 0 generator output (`pnpm -C spikes/phase0 fixtures:textlayer` and `... fixtures:objects`) or its ported copy in test-assets/.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEXT_LINES,
  TEXT_PAGE,
  buildBlankPdf,
  buildFontFixturePdf,
  buildFormPdf,
  buildHeavyPdf,
  buildNavigationPdf,
  buildPagesPdf,
  buildTextPdf,
  buildXfaPdf,
  LINK_RECT,
} from '../../../test/spec-blind/fixtures';
import type { FormKind, TextPdf } from '../../../test/spec-blind/fixtures';
import {
  classifier,
  contains,
  copyOf,
  fetchText,
  generated,
  helveticaWidth,
  installWorkerSpy,
  measureInk,
  meanAbsDiff,
  overlapArea,
  readPixels,
  sleep,
  toBitmap,
} from '../../../test/spec-blind/browser-helpers';
import type { WorkerSpy } from '../../../test/spec-blind/browser-helpers';
import { PdfFormatError, PdfPasswordError } from '../errors';
import { hasFillableFields } from '../forms';
import type { DocHandle, FormInfo, Glyph, OpenResult, PdfBackend, PdfRect, Rotation } from '../types';
import { engineAssets } from './assets';
import { createEmbedPdfBackend } from './backend';

// The extension passes chrome.runtime.getURL; the test passes a URL for apps/extension/public/ (interface file).
const ASSETS = engineAssets((path) => new URL(`/apps/extension/public/${path}`, globalThis.location.href).href);

const SLOW = 30_000;
const VERY_SLOW = 150_000;

// The Worker spy is installed before any backend starts its worker, and stays for the whole file.
let spy: WorkerSpy;
let backend: PdfBackend;
beforeAll(() => {
  spy = installWorkerSpy();
  backend = createEmbedPdfBackend(ASSETS);
});
afterAll(() => {
  (backend as { dispose?: () => void }).dispose?.();
  spy.restore();
});

/** Opens `bytes` (a copy: open() transfers its buffer), runs `fn`, and always closes the document. */
async function withDoc<T>(bytes: Uint8Array, fn: (doc: DocHandle, info: OpenResult) => T | Promise<T>, be: PdfBackend = backend, password?: string): Promise<T> {
  const info = await be.open(copyOf(bytes), password === undefined ? undefined : { password });
  try {
    return await fn(info.doc, info);
  } finally {
    await be.close(info.doc).catch(() => undefined);
  }
}

const norm = (s: string) => s.normalize('NFKC').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
const squash = (s: string) => norm(s).replace(/\s+/g, '');
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

let textPdf: TextPdf;
beforeAll(async () => {
  textPdf = await buildTextPdf();
});

// =================================================================================================================
// Opening documents

describe('open: page count, page sizes and metadata', () => {
  // Page counts and sizes of the real files come from the classifier manifest (written by an independent tool).
  const REAL: { file: string; pages: number; width: number; height: number }[] = [
    { file: 'learning/arxiv-1706.03762-attention.pdf', pages: 15, width: 612, height: 792 },
    { file: 'learning/arxiv-1802.03042-deep-hedging.pdf', pages: 32, width: 595.276, height: 841.89 },
    { file: 'learning/plosone-10.1371-journal.pone.0000308.pdf', pages: 5, width: 612.283, height: 790.866 },
    { file: 'learning/textbook-axler-LADR4e.pdf', pages: 404, width: 375, height: 636 },
    { file: 'learning/slides-cs50-2023-lecture0.pdf', pages: 192, width: 720, height: 405 },
    { file: 'not-learning/receipt-wholefoods-scan.pdf', pages: 1, width: 222, height: 1046 },
  ];
  it.each(REAL)('$file has $pages pages, the first $width x $height pt', async ({ file, pages, width, height }) => {
    await withDoc(await classifier(file), (_doc, info) => {
      expect(info.pageCount).toBe(pages);
      expect(info.pages).toHaveLength(pages);
      expect(info.pages[0].width).toBeCloseTo(width, 1);
      expect(info.pages[0].height).toBeCloseTo(height, 1);
      expect(info.pages[0].rotation).toBe(0);
      expect(info.encrypted).toBe(false);
    });
  }, SLOW);

  it('reports every page of a mixed-size document, in order', async () => {
    const sizes = [
      { width: 612, height: 792 },
      { width: 595.276, height: 841.89 },
      { width: 720, height: 405 },
      { width: 200, height: 300 },
      { width: 2000, height: 500 },
    ];
    await withDoc(await buildPagesPdf(sizes), (_doc, info) => {
      expect(info.pageCount).toBe(sizes.length);
      sizes.forEach((s, i) => {
        expect(info.pages[i].width, `page ${i} width`).toBeCloseTo(s.width, 1);
        expect(info.pages[i].height, `page ${i} height`).toBeCloseTo(s.height, 1);
        expect(info.pages[i].rotation).toBe(0);
      });
    });
  }, SLOW);

  it.each([0, 90, 180, 270] as const)('reports /Rotate %i as the page rotation', async (rotate) => {
    await withDoc(await buildPagesPdf([{ width: 612, height: 792, rotate }]), (_doc, info) => {
      expect(info.pages[0].rotation).toBe(rotate);
      // Whichever way a consumer reads width and height, the page is 612 by 792 pt.
      expect(Math.min(info.pages[0].width, info.pages[0].height)).toBeCloseTo(612, 1);
      expect(Math.max(info.pages[0].width, info.pages[0].height)).toBeCloseTo(792, 1);
    });
  }, SLOW);

  // GUESS: PdfRect is "unrotated page space" and the interface says rotation is the page's /Rotate, so width and height are
  // the unrotated MediaBox size and a /Rotate 90 page stays 612 x 792. PDFium's own FPDF_GetPageWidth would give 792 x 612.
  it('reports the unrotated size for a /Rotate 90 page (guess)', async () => {
    await withDoc(await buildPagesPdf([{ width: 612, height: 792, rotate: 90 }]), (_doc, info) => {
      expect(info.pages[0].width).toBeCloseTo(612, 1);
      expect(info.pages[0].height).toBeCloseTo(792, 1);
    });
  }, SLOW);

  it('returns the document information, and null for entries the file does not have', async () => {
    const meta = { title: 'Spec Blind Title', author: 'A. Reader', subject: 'Tides', keywords: ['rivers', 'silt'], creator: 'Test Suite', producer: 'pdf-lib' };
    await withDoc(await buildPagesPdf([{ width: 612, height: 792 }], meta), (_doc, info) => {
      expect(info.metadata).toMatchObject({ title: 'Spec Blind Title', author: 'A. Reader', subject: 'Tides', keywords: 'rivers silt', creator: 'Test Suite', producer: 'pdf-lib' });
    });
    // GUESS: an entry the file lacks is null (the type is string | null), not ''. pdf-lib writes no /ID, so pdfId is null too.
    await withDoc(await buildPagesPdf([{ width: 612, height: 792 }]), (_doc, info) => {
      expect(info.metadata).toEqual({ title: null, author: null, subject: null, keywords: null, creator: null, producer: null, pdfId: null });
    });
    // pdfTeX writes a file /ID.
    await withDoc(await classifier('learning/arxiv-1706.03762-attention.pdf'), (_doc, info) => {
      expect(typeof info.metadata.pdfId).toBe('string');
      expect(info.metadata.pdfId?.length).toBeGreaterThan(0);
    });
  }, SLOW);

  it('takes ownership of the buffer, and a closed document rejects further calls', async () => {
    const buf = copyOf(await buildBlankPdf());
    const before = buf.byteLength;
    expect(before).toBeGreaterThan(0);
    const info = await backend.open(buf);
    expect(buf.byteLength, 'open() transfers the bytes to the worker, which detaches the buffer').toBe(0);
    const other = await backend.open(copyOf(textPdf.bytes));
    expect(other.doc).not.toBe(info.doc);
    expect(norm(await backend.getPageText(other.doc, 0))).toBe(textPdf.flat);
    await backend.close(info.doc);
    await expect(backend.getPageText(info.doc, 0)).rejects.toBeInstanceOf(Error);
    // the other document is untouched by closing the first
    expect(norm(await backend.getPageText(other.doc, 0))).toBe(textPdf.flat);
    await backend.close(other.doc);
  }, SLOW);
});

describe('open: passwords and corrupt files', () => {
  const ENCRYPTED = ['RC4-128', 'AES-128', 'AES-256'];
  async function encrypted(name: string): Promise<Uint8Array> {
    const res = await fetch(new URL(`../../../test/spec-blind-fixtures/${name}`, import.meta.url));
    if (!res.ok) throw new Error(`fixture ${name} missing (HTTP ${res.status}); python3 -I packages/viewer/test/spec-blind-fixtures/make-encrypted.py`);
    return new Uint8Array(await res.arrayBuffer());
  }

  it.each(ENCRYPTED)('%s: asks for a password, rejects a wrong one, and opens with the right one', async (algorithm) => {
    const bytes = await encrypted(`enc-${algorithm}.pdf`);
    const missing = await backend.open(copyOf(bytes)).then(() => null, (e: unknown) => e);
    expect(missing, 'no password given').toBeInstanceOf(PdfPasswordError);
    expect((missing as PdfPasswordError).wrongPassword, 'no password given is not "wrong password"').toBe(false);

    const wrong = await backend.open(copyOf(bytes), { password: 'not-it' }).then(() => null, (e: unknown) => e);
    expect(wrong, 'wrong password').toBeInstanceOf(PdfPasswordError);
    expect((wrong as PdfPasswordError).wrongPassword).toBe(true);

    // the same backend, straight after two failures
    await withDoc(bytes, async (doc, info) => {
      expect(info.encrypted).toBe(true);
      expect(info.pageCount).toBe(1);
      expect(norm(await backend.getPageText(doc, 0))).toBe('Secret passage: swordfish 42');
    }, backend, 'open-sesame');
  }, SLOW);

  it('opens a file whose user password is empty without asking, and still reports it as encrypted', async () => {
    await withDoc(await encrypted('enc-owner-only.pdf'), async (doc, info) => {
      expect(info.encrypted).toBe(true);
      expect(norm(await backend.getPageText(doc, 0))).toBe('Secret passage: swordfish 42');
    });
  }, SLOW);

  const lcg = (n: number) => {
    let s = 12345;
    return Uint8Array.from({ length: n }, () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s >> 16));
  };
  const text = (s: string) => new TextEncoder().encode(s);
  it.each([
    { name: 'an empty file', bytes: new Uint8Array(0) },
    { name: 'plain text', bytes: text('This is not a PDF file, only a sentence.\n') },
    { name: 'a PDF header followed by junk', bytes: new Uint8Array([...text('%PDF-1.7\n'), ...lcg(2048)]) },
    { name: 'random bytes', bytes: lcg(4096) },
  ])('rejects $name with the format error, not the password error', async ({ bytes }) => {
    const err = await backend.open(copyOf(bytes)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PdfFormatError);
    expect(err).not.toBeInstanceOf(PdfPasswordError);
    // the worker is still healthy afterwards
    await withDoc(await buildBlankPdf(), (_doc, info) => expect(info.pageCount).toBe(1));
  }, SLOW);
});

// =================================================================================================================
// Rendering

describe('renderTile', () => {
  // The text block of the generated page, in points (top-left origin): from the left edge of line 1 to its right edge, and
  // from the top of the capitals on line 1 to the baseline of line 3 (which has no descenders).
  const INK = { x0: 72, x1: 271.1, y0: 89.9, y1: 180 };
  const page = { width: TEXT_PAGE.width, height: TEXT_PAGE.height };

  const CASES: { scale: number; viewRotation: Rotation }[] = [
    { scale: 0.5, viewRotation: 0 },
    { scale: 1, viewRotation: 0 },
    { scale: 1.5, viewRotation: 0 },
    { scale: 2, viewRotation: 0 },
    { scale: 1, viewRotation: 90 },
    { scale: 1.5, viewRotation: 180 },
    { scale: 2, viewRotation: 270 },
  ];
  // GUESS: viewRotation turns the view clockwise (90 puts the top of the page on the right), as every viewer's Rotate does.
  it.each(CASES)('scale $scale, view rotated $viewRotation: right size, ink in the right place', async ({ scale, viewRotation }) => {
    await withDoc(textPdf.bytes, async (doc) => {
      const bmp = await backend.renderTile(doc, { pageIndex: 0, scale, viewRotation, withAnnotations: false });
      const swap = viewRotation === 90 || viewRotation === 270;
      expect(Math.abs(bmp.width - (swap ? page.height : page.width) * scale), 'width').toBeLessThanOrEqual(1);
      expect(Math.abs(bmp.height - (swap ? page.width : page.height) * scale), 'height').toBeLessThanOrEqual(1);
      const ink = measureInk(readPixels(bmp));
      bmp.close();
      expect(ink.count, 'dark pixels').toBeGreaterThan(100);
      const a = toBitmap({ x: INK.x0, y: INK.y0 }, page, scale, viewRotation);
      const b = toBitmap({ x: INK.x1, y: INK.y1 }, page, scale, viewRotation);
      const tol = 3 * scale + 1;
      expect(ink.box!.left).toBeGreaterThanOrEqual(Math.min(a.x, b.x) - tol);
      expect(ink.box!.left).toBeLessThanOrEqual(Math.min(a.x, b.x) + tol);
      expect(ink.box!.right).toBeGreaterThanOrEqual(Math.max(a.x, b.x) - tol);
      expect(ink.box!.right).toBeLessThanOrEqual(Math.max(a.x, b.x) + tol);
      expect(ink.box!.top).toBeGreaterThanOrEqual(Math.min(a.y, b.y) - tol);
      expect(ink.box!.top).toBeLessThanOrEqual(Math.min(a.y, b.y) + tol);
      expect(ink.box!.bottom).toBeGreaterThanOrEqual(Math.max(a.y, b.y) - tol);
      expect(ink.box!.bottom).toBeLessThanOrEqual(Math.max(a.y, b.y) + tol);
    });
  }, SLOW);

  it('draws a page with no content as one flat colour', async () => {
    await withDoc(await buildBlankPdf(), async (doc) => {
      const bmp = await backend.renderTile(doc, { pageIndex: 0, scale: 1, viewRotation: 0, withAnnotations: false });
      const ink = measureInk(readPixels(bmp));
      bmp.close();
      expect(ink.uniform).toBe(true);
      expect(ink.count).toBe(0);
    });
  }, SLOW);

  // GUESS: with viewRotation 0 a page whose /Rotate is 90 is drawn as the PDF displays it, 792 x 612 pt.
  it('draws a /Rotate 90 page as the file displays it', async () => {
    await withDoc(await buildPagesPdf([{ width: 612, height: 792, rotate: 90 }]), async (doc) => {
      const bmp = await backend.renderTile(doc, { pageIndex: 0, scale: 1, viewRotation: 0, withAnnotations: false });
      expect(Math.abs(bmp.width - 792)).toBeLessThanOrEqual(1);
      expect(Math.abs(bmp.height - 612)).toBeLessThanOrEqual(1);
      bmp.close();
    });
  }, SLOW);

  it.each([
    { name: 'a tile over line 1', rect: { x: 60, y: 80, width: 300, height: 40 }, blank: false },
    { name: 'a tile over empty paper', rect: { x: 60, y: 500, width: 300, height: 40 }, blank: true },
  ])('$name has the tile size and is the same picture as that part of the full page', async ({ rect, blank }) => {
    const scale = 2;
    await withDoc(textPdf.bytes, async (doc) => {
      const tile = await backend.renderTile(doc, { pageIndex: 0, scale, rect, viewRotation: 0, withAnnotations: false });
      expect(Math.abs(tile.width - rect.width * scale)).toBeLessThanOrEqual(1);
      expect(Math.abs(tile.height - rect.height * scale)).toBeLessThanOrEqual(1);
      const full = await backend.renderTile(doc, { pageIndex: 0, scale, viewRotation: 0, withAnnotations: false });
      const tilePx = readPixels(tile);
      const cropPx = readPixels(full, { x: rect.x * scale, y: rect.y * scale, width: tile.width, height: tile.height });
      tile.close();
      full.close();
      expect(measureInk(tilePx).uniform).toBe(blank);
      expect(meanAbsDiff(tilePx, cropPx), 'tile versus the same crop of the full render').toBeLessThan(3);
    });
  }, SLOW);

  it('lets bundled fonts draw text the file does not embed (Latin and CJK fallbacks come from the extension)', async () => {
    // Phase 0 (P0-1): ink 0.0295 with the bundled CJK font against 0.0031 without it.
    await withDoc(buildFontFixturePdf(), async (doc) => {
      const bmp = await backend.renderTile(doc, { pageIndex: 0, scale: 1.5, viewRotation: 0, withAnnotations: false });
      const ink = measureInk(readPixels(bmp));
      bmp.close();
      expect(ink.share, 'share of dark pixels').toBeGreaterThan(0.008);
    });
  }, SLOW);

  it('an aborted tile rejects with AbortError, and the render in flight is not disturbed', async () => {
    await withDoc(await buildHeavyPdf(), async (doc) => {
      const req = { pageIndex: 0, scale: 3, viewRotation: 0 as const, withAnnotations: false };
      const first = backend.renderTile(doc, req);
      const ctl = new AbortController();
      const queued = backend.renderTile(doc, { ...req, scale: 2 }, ctl.signal);
      ctl.abort();
      const err = await queued.then(() => null, (e: unknown) => e);
      expect((err as { name?: string } | null)?.name).toBe('AbortError');
      const bmp = await first;
      expect(bmp.width).toBeGreaterThan(0);
      bmp.close();
      const after = await backend.renderTile(doc, { ...req, scale: 1 });
      expect(after.width).toBeGreaterThan(0);
      after.close();
    });
  }, SLOW);
});

// =================================================================================================================
// Text

describe('text: glyph boxes and ranges', () => {
  /** Index in the page text of char `at` of generated line `line` (PDFium puts a generated CR LF between lines). */
  const pageIndex = (line: number, at: number) => TEXT_LINES.slice(0, line).reduce((n, l) => n + l.text.length + 2, 0) + at;

  it('every glyph box matches the font metrics of the generated line', async () => {
    await withDoc(textPdf.bytes, async (doc) => {
      const { glyphs, runs, pageIndex: pi } = await backend.getPageGlyphs(doc, 0);
      expect(pi).toBe(0);
      const byIndex = new Map<number, Glyph>(glyphs.map((g) => [g.index, g]));
      const problems: string[] = [];
      for (const c of textPdf.chars) {
        const idx = pageIndex(c.line, c.at);
        const g = byIndex.get(idx);
        if (!g) {
          problems.push(`no glyph with index ${idx} for ${JSON.stringify(c.ch)}`);
          continue;
        }
        const tag = `#${idx} ${JSON.stringify(c.ch)}`;
        if (g.text !== c.ch) problems.push(`${tag}: text ${JSON.stringify(g.text)}`);
        if (g.generated) problems.push(`${tag}: marked generated`);
        if (!near(g.box.x, c.x, 0.3)) problems.push(`${tag}: box.x ${g.box.x.toFixed(2)}, expected ${c.x.toFixed(2)}`);
        if (!near(g.box.width, c.advance, 0.3)) problems.push(`${tag}: box.width ${g.box.width.toFixed(2)}, expected ${c.advance.toFixed(2)}`);
        if (!(g.box.y < c.baseline && g.box.y + g.box.height > c.baseline)) problems.push(`${tag}: box ${g.box.y.toFixed(1)}+${g.box.height.toFixed(1)} does not span the baseline ${c.baseline}`);
        if (g.box.height < TEXT_PAGE.fontSize * 0.9 || g.box.height > TEXT_PAGE.fontSize * 2) problems.push(`${tag}: box.height ${g.box.height.toFixed(1)}`);
        if (!near(g.fontSize, TEXT_PAGE.fontSize, 0.1)) problems.push(`${tag}: fontSize ${g.fontSize}`);
        if (!near(g.angle, 0, 0.01)) problems.push(`${tag}: angle ${g.angle}`);
        if (!contains(g.box, g.tight, 0.5)) problems.push(`${tag}: tight box ${JSON.stringify(g.tight)} outside box ${JSON.stringify(g.box)}`);
      }
      expect(problems, problems.slice(0, 8).join('\n')).toEqual([]);
      // The line breaks PDFium adds are in the list and marked generated, not mistaken for text.
      const breaks = glyphs.filter((g) => g.generated);
      expect(breaks.map((g) => g.index)).toEqual([30, 31, 57, 58]);
      expect(breaks.every((g) => /^[\r\n]$/.test(g.text))).toBe(true);
      // Runs are index ranges inside the glyph list, in order and without overlap.
      expect(runs.length).toBeGreaterThanOrEqual(1);
      runs.forEach((r, k) => {
        expect(r.start).toBeLessThanOrEqual(r.end);
        if (k > 0) expect(r.start).toBeGreaterThanOrEqual(runs[k - 1].end);
      });
    });
  }, SLOW);

  const RANGES = [
    { name: 'a word at the start', line: 0, at: 0, count: 5, expected: 'Alpha' },
    { name: 'a word in the middle of a line', line: 0, at: 11, count: 5, expected: 'gamma' },
    { name: 'a whole second line', line: 1, at: 0, count: 'Zeta eta theta iota kappa'.length, expected: 'Zeta eta theta iota kappa' },
    { name: 'the last word of the page', line: 2, at: 16, count: 7, expected: 'omicron' },
  ];
  it.each(RANGES)('getTextRange returns $name', async ({ line, at, count, expected }) => {
    await withDoc(textPdf.bytes, async (doc) => {
      expect(await backend.getTextRange(doc, 0, pageIndex(line, at), count)).toBe(expected);
    });
  }, SLOW);

  it('a range across a line break returns both lines, and the page text is the three lines', async () => {
    await withDoc(textPdf.bytes, async (doc) => {
      const start = pageIndex(0, TEXT_LINES[0].text.indexOf('epsilon'));
      expect(norm(await backend.getTextRange(doc, 0, start, 7 + 2 + 4))).toBe('epsilon Zeta');
      expect(norm(await backend.getPageText(doc, 0))).toBe(textPdf.flat);
      const { glyphs } = await backend.getPageGlyphs(doc, 0);
      expect(glyphs.filter((g) => !g.generated).map((g) => g.text).join('')).toBe(TEXT_LINES.map((l) => l.text).join(''));
    });
  }, SLOW);

  // Truth: spikes/phase0/fixtures/src/<name>.txt, written by hand as a reader would copy the page (P0-4).
  // PDFium inserts line breaks of its own inside the rotated table and around superscripts, so those two are compared
  // with all whitespace removed (R26); the rest must match exactly once whitespace is collapsed.
  const TEXT_FIXTURES = [
    { fixture: 'two-column', pdf: 'tl-two-column.pdf', truth: 'two-column', mode: 'exact' },
    { fixture: 'ligatures (fi, fl, ff, ffi)', pdf: 'tl-ligatures.pdf', truth: 'ligatures', mode: 'exact' },
    { fixture: 'two-column with /Rotate 90', pdf: 'tl-rotated-page.pdf', truth: 'two-column', mode: 'exact' },
    { fixture: 'rotated table', pdf: 'tl-rotated-table.pdf', truth: 'rotated-table', mode: 'squash' },
    { fixture: 'inline maths', pdf: 'tl-maths.pdf', truth: 'maths', mode: 'squash' },
  ] as const;
  it.each(TEXT_FIXTURES)('page text of the $fixture fixture equals the generator truth', async ({ pdf, truth, mode }) => {
    const bytes = await generated(pdf, 'Run `pnpm -C spikes/phase0 fixtures:textlayer`.');
    const expected = await fetchText(`spikes/phase0/fixtures/src/${truth}.txt`);
    const f = mode === 'exact' ? norm : squash;
    await withDoc(bytes, async (doc) => {
      const text = await backend.getPageText(doc, 0);
      expect(f(text)).toBe(f(expected));
      // the glyph list is the same text, char for char, and getTextRange(0, n) agrees with both
      const { glyphs } = await backend.getPageGlyphs(doc, 0);
      expect(f(glyphs.map((g) => g.text).join(''))).toBe(f(expected));
      expect(f(await backend.getTextRange(doc, 0, 0, glyphs.length))).toBe(f(expected));
    });
  }, SLOW);

  const SEARCHES = [
    { query: 'eta', matchCase: false, wholeWord: false },
    { query: 'eta', matchCase: false, wholeWord: true },
    { query: 'Zeta', matchCase: true, wholeWord: false },
    { query: 'zeta', matchCase: true, wholeWord: false },
    { query: 'ZETA', matchCase: false, wholeWord: true },
    { query: 'omicron', matchCase: true, wholeWord: true },
    { query: 'not on the page', matchCase: false, wholeWord: false },
  ];
  it.each(SEARCHES)('searchPage "$query" (matchCase $matchCase, wholeWord $wholeWord)', async ({ query, matchCase, wholeWord }) => {
    // Expected hits from the known text, with PDFium's CR LF between the lines so that the indices line up.
    const pageText = TEXT_LINES.map((l) => l.text).join('\r\n');
    const re = new RegExp(`${wholeWord ? '\\b' : ''}${query}${wholeWord ? '\\b' : ''}`, matchCase ? 'g' : 'gi');
    const expected = [...pageText.matchAll(re)].map((m) => m.index);
    await withDoc(textPdf.bytes, async (doc) => {
      const hits = await backend.searchPage(doc, 0, query, { matchCase, wholeWord });
      expect(hits.map((h) => h.start)).toEqual(expected);
      for (const h of hits) {
        expect(h.pageIndex).toBe(0);
        expect(h.count).toBe(query.length);
        expect((await backend.getTextRange(doc, 0, h.start, h.count)).toLowerCase()).toBe(query.toLowerCase());
        expect(h.rects.length).toBeGreaterThanOrEqual(1);
        for (const r of h.rects) expect(contains({ x: 0, y: 0, width: TEXT_PAGE.width, height: TEXT_PAGE.height }, r, 0.5)).toBe(true);
      }
    });
  }, SLOW);
});

// =================================================================================================================
// Selection rectangles (carried requirement)

describe('selection rectangles', () => {
  // The backend returns PDFium's merged rectangles for a char range (FPDFText_CountRects / GetRect). The method's name and
  // exact parameter list are not in the interface; the brief says "something like getTextRangeRects(page, charStart, charCount)".
  // GUESS: getTextRangeRects(doc, pageIndex, charStart, charCount): Promise<PdfRect[]>.
  const NAMES = ['getTextRangeRects', 'getTextRects', 'getSelectionRects', 'getRangeRects'] as const;
  function rangeRects(doc: DocHandle, pageIdx: number, start: number, count: number): Promise<PdfRect[]> {
    const be = backend as unknown as Record<string, (...a: unknown[]) => Promise<PdfRect[]>>;
    const name = NAMES.find((n) => typeof be[n] === 'function');
    if (!name) throw new Error(`PdfBackend has no selection-rectangles method (looked for ${NAMES.join(', ')}); the carried requirement asks for one`);
    return be[name](doc, pageIdx, start, count);
  }

  /** Index ranges of the lines of a page: glyphs between the generated line breaks PDFium adds. */
  function lineRanges(glyphs: Glyph[]): { start: number; end: number }[] {
    const lines: { start: number; end: number }[] = [];
    let cur: { start: number; end: number } | null = null;
    for (const g of glyphs) {
      if (g.generated && (g.text === '\r' || g.text === '\n')) {
        cur = null;
        continue;
      }
      if (!cur) lines.push((cur = { start: g.index, end: g.index }));
      cur.end = g.index + 1;
    }
    return lines;
  }

  const CASES = [
    { name: 'a range over two generated lines', file: 'generated', lineFrom: 0, lineTo: 1, trim: { from: 11, to: -6 } },
    { name: 'the whole generated page (3 lines)', file: 'generated', lineFrom: 0, lineTo: 2, trim: { from: 0, to: 0 } },
    { name: 'a range inside one generated line', file: 'generated', lineFrom: 1, lineTo: 1, trim: { from: 5, to: -6 } },
    { name: 'lines 11 to 13 of a LaTeX paper page', file: 'learning/nber-w29000.pdf', page: 3, lineFrom: 10, lineTo: 12, trim: { from: 0, to: 0 } },
  ];
  it.each(CASES)('$name: one rect per line, no overlap, inside the page, covering the glyphs', async ({ file, page: pageIdx = 0, lineFrom, lineTo, trim }) => {
    const bytes = file === 'generated' ? textPdf.bytes : await classifier(file);
    await withDoc(bytes, async (doc, info) => {
      const { glyphs } = await backend.getPageGlyphs(doc, pageIdx);
      const lines = lineRanges(glyphs);
      const start = lines[lineFrom].start + trim.from;
      const end = lines[lineTo].end + trim.to;
      const rects = await rangeRects(doc, pageIdx, start, end - start);
      const size = info.pages[pageIdx];

      expect(rects, `${lineTo - lineFrom + 1} line(s)`).toHaveLength(lineTo - lineFrom + 1);
      for (const r of rects) {
        expect(r.width).toBeGreaterThan(0);
        expect(r.height).toBeGreaterThan(0);
        expect(contains({ x: 0, y: 0, width: size.width, height: size.height }, r, 0.5), `inside the page: ${JSON.stringify(r)}`).toBe(true);
      }
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlapArea(rects[i], rects[j]), `rects ${i} and ${j} overlap`).toBeLessThan(0.01);

      // Each line's glyphs sit in one rect, and no two lines share one: the rects line up with the lines.
      const owners = new Map<number, number>();
      for (const g of glyphs) {
        if (g.generated || g.index < start || g.index >= end) continue;
        const line = lines.findIndex((l) => g.index >= l.start && g.index < l.end);
        // PDFium's merged rect is the union of the chars' (tight) boxes, so a glyph is covered when its tight box is inside.
        const hit = rects.findIndex((r) => contains(r, g.tight, 0.6));
        expect(hit, `glyph #${g.index} ${JSON.stringify(g.text)} is covered by a rect`).toBeGreaterThanOrEqual(0);
        if (owners.has(line)) expect(hit, `line ${line} spans two rects`).toBe(owners.get(line));
        else owners.set(line, hit);
      }
      expect(new Set(owners.values()).size, 'lines share a rect').toBe(owners.size);
    });
  }, SLOW);

  it('a one-line range starts at its first glyph and ends at its last', async () => {
    await withDoc(textPdf.bytes, async (doc) => {
      const { glyphs } = await backend.getPageGlyphs(doc, 0);
      const lines = lineRanges(glyphs);
      const start = lines[1].start + 5; // "eta theta"
      const count = 9;
      const rects = await rangeRects(doc, 0, start, count);
      expect(rects).toHaveLength(1);
      const first = glyphs.find((g) => g.index === start)!;
      const last = glyphs.find((g) => g.index === start + count - 1)!;
      expect(near(rects[0].x, first.tight.x, 0.6), `left edge ${rects[0].x} vs ${first.tight.x}`).toBe(true);
      expect(near(rects[0].x + rects[0].width, last.tight.x + last.tight.width, 0.6), 'right edge').toBe(true);
    });
  }, SLOW);
});

// =================================================================================================================
// Forms

describe('getFormInfo', () => {
  type Expect = { formType: FormInfo['formType']; fillable: boolean; first?: number | null };

  // pagesWalked depends on the form structure there is to walk (carried requirement, as clarified by the task owner):
  // - 'acroform' with nothing fillable (hyperref papers, a signature field only): every page was read, pagesWalked === pageCount;
  // - 'acroform' with a fillable widget: the walk stops there, so pagesWalked is between firstFillablePage + 1 and pageCount;
  // - 'none' (no /AcroForm) and the XFA types (never walked): nothing was walked, pagesWalked === 0.
  function check(info: FormInfo, pageCount: number, want: Expect) {
    expect(info.formType).toBe(want.formType);
    expect(hasFillableFields(info)).toBe(want.fillable);
    if (want.first !== undefined) expect(info.firstFillablePage).toBe(want.first);
    expect(info.pagesWalked, 'FormInfo.pagesWalked').toBeTypeOf('number');
    if (want.formType !== 'acroform') {
      expect(info.pagesWalked, `pagesWalked of a ${want.formType} document`).toBe(0);
    } else if (!want.fillable) {
      expect(info.pagesWalked, 'pagesWalked of an /AcroForm with nothing fillable').toBe(pageCount);
    } else {
      expect(info.pagesWalked).toBeGreaterThanOrEqual((info.firstFillablePage ?? 0) + 1);
      expect(info.pagesWalked).toBeLessThanOrEqual(pageCount);
    }
  }

  // Generated by pdf-lib, mirroring what P0-7 pinned down on PDFium: a push button before the field must not count,
  // a signature field is not a fillable field, and hyperref's empty /AcroForm and plain link boxes are not forms.
  const GENERATED: { kind: FormKind; want: Expect }[] = [
    { kind: 'textfield', want: { formType: 'acroform', fillable: true, first: 1 } },
    { kind: 'checkbox', want: { formType: 'acroform', fillable: true, first: 1 } },
    { kind: 'radiobutton', want: { formType: 'acroform', fillable: true, first: 1 } },
    { kind: 'combobox', want: { formType: 'acroform', fillable: true, first: 1 } },
    { kind: 'listbox', want: { formType: 'acroform', fillable: true, first: 1 } },
    { kind: 'signature-only', want: { formType: 'acroform', fillable: false, first: null } },
    { kind: 'empty-acroform', want: { formType: 'acroform', fillable: false, first: null } },
    { kind: 'links-only', want: { formType: 'none', fillable: false, first: null } },
  ];
  it.each(GENERATED)('generated "$kind" document', async ({ kind, want }) => {
    const { bytes, pageCount } = await buildFormPdf(kind);
    await withDoc(bytes, async (doc) => {
      const info = await backend.getFormInfo(doc);
      check(info, pageCount, want);
      // asking again gives the same answer (the result is computed once per document)
      expect(await backend.getFormInfo(doc)).toEqual(info);
    });
  }, SLOW);

  it.each([
    { needsRendering: false, formType: 'xfa-foreground' },
    { needsRendering: true, formType: 'xfa-full' },
  ] as const)('an /XFA form ($formType) is fillable', async ({ needsRendering, formType }) => {
    await withDoc(await buildXfaPdf(needsRendering), async (doc) => {
      check(await backend.getFormInfo(doc), 1, { formType, fillable: true, first: null });
    });
  }, SLOW);

  // Real files: the hyperref papers have link boxes (and an /AcroForm with no fields) but are not forms; the HMRC and W-9
  // forms are (HMRC: text fields from its third page, W-9: XFA). Sizes from the classifier manifest.
  const REAL: { file: string; pages: number; want: Expect }[] = [
    { file: 'learning/nber-w29000.pdf', pages: 133, want: { formType: 'acroform', fillable: false, first: null } },
    { file: 'learning/lse-cep-dp1800.pdf', pages: 89, want: { formType: 'acroform', fillable: false, first: null } },
    { file: 'learning/lecture-notes-mit-6.006-lec1.pdf', pages: 5, want: { formType: 'acroform', fillable: false, first: null } },
    { file: 'learning/arxiv-1706.03762-attention.pdf', pages: 15, want: { formType: 'none', fillable: false, first: null } },
    { file: 'not-learning/tax-form-hmrc-sa100-2026.pdf', pages: 10, want: { formType: 'acroform', fillable: true, first: 2 } },
    { file: 'not-learning/tax-form-irs-w9.pdf', pages: 6, want: { formType: 'xfa-foreground', fillable: true } },
  ];
  it.each(REAL)('$file', async ({ file, pages, want }) => {
    await withDoc(await classifier(file), async (doc, open) => {
      expect(open.pageCount).toBe(pages);
      check(await backend.getFormInfo(doc), pages, want);
    });
  }, SLOW);
});

// =================================================================================================================
// Links, outline, page objects, structure and text runs (what Phase 1 and 2 build on)

describe('navigation data', () => {
  it('getLinks gives rects in top-left page space with a url or a page target', async () => {
    await withDoc(await buildNavigationPdf(), async (doc) => {
      const links = await backend.getLinks(doc, 0);
      expect(links).toHaveLength(2);
      const url = links.find((l) => l.target.kind === 'url')!;
      expect(url.target).toEqual({ kind: 'url', url: 'https://example.org/paper' });
      expect(url.rect.x).toBeCloseTo(LINK_RECT.x, 0);
      expect(url.rect.width).toBeCloseTo(LINK_RECT.width, 0);
      expect(url.rect.height).toBeCloseTo(LINK_RECT.height, 0);
      expect(url.rect.y, 'the generator put the link 172 pt from the top (792 - 600 - 20)').toBeCloseTo(792 - LINK_RECT.y - LINK_RECT.height, 0);
      const jump = links.find((l) => l.target.kind === 'page')!;
      expect(jump.target).toMatchObject({ kind: 'page', pageIndex: 2 });
      const t = jump.target as { left: number | null; top: number | null };
      expect(t.left).toBeCloseTo(100, 0);
      // GUESS: destination y is converted to the same top-left space as every other coordinate (792 - 500).
      expect(t.top).toBeCloseTo(292, 0);
      expect(await backend.getLinks(doc, 1)).toEqual([]);
    });
  }, SLOW);

  it('getOutline gives the bookmark tree with page targets', async () => {
    await withDoc(await buildNavigationPdf(), async (doc) => {
      const outline = await backend.getOutline(doc);
      expect(outline.map((o) => o.title)).toEqual(['Chapter 1', 'Chapter 2']);
      expect(outline[0].target).toMatchObject({ kind: 'page', pageIndex: 0 });
      expect(outline[1].target).toMatchObject({ kind: 'page', pageIndex: 2 });
      expect(outline[0].children.map((o) => o.title)).toEqual(['Section 1.1']);
      expect(outline[0].children[0].target).toMatchObject({ kind: 'page', pageIndex: 1 });
      expect(outline[0].children[0].children).toEqual([]);
    });
    await withDoc(textPdf.bytes, async (doc) => expect(await backend.getOutline(doc)).toEqual([]));
  }, SLOW);
});

describe('page objects, structure tree and text runs (Phase 0 P0-10 truth)', () => {
  const OBJECTS_HINT = 'Run `pnpm -C spikes/phase0 fixtures:objects` (or the ported scripts/fixtures/make-objects.mjs).';

  it('listPageObjects counts what the generator drew, and stops at the cap', async () => {
    // objects.pdf page 1: one 432 x 288 px JPEG at (72, 90, 216 x 144), a chart of exactly 48 paths, 44 drawText calls.
    // Page 2: 50,000 filled rectangles.
    const bytes = await generated('objects.pdf', OBJECTS_HINT);
    await withDoc(bytes, async (doc) => {
      const p1 = await backend.listPageObjects(doc, 0);
      expect(p1.truncated).toBe(false);
      const count = (t: string) => p1.objects.filter((o) => o.type === t).length;
      expect({ image: count('image'), path: count('path'), text: count('text') }).toEqual({ image: 1, path: 48, text: 44 });
      expect(p1.objects).toHaveLength(93);
      const img = p1.objects.find((o) => o.type === 'image')!;
      expect(img.bounds.x).toBeCloseTo(72, 0);
      expect(img.bounds.y).toBeCloseTo(90, 0);
      expect(img.bounds.width).toBeCloseTo(216, 0);
      expect(img.bounds.height).toBeCloseTo(144, 0);
      expect(img.image).toMatchObject({ pixelWidth: 432, pixelHeight: 288 });
      expect(img.image?.filters).toContain('DCTDecode');
      expect(p1.objects.every((o) => o.formDepth === 0)).toBe(true);

      const capped = await backend.listPageObjects(doc, 1, { maxObjects: 1000 });
      expect(capped.truncated).toBe(true);
      expect(capped.objects.length).toBeGreaterThan(0);
      expect(capped.objects.length).toBeLessThanOrEqual(1000);
      // the default budget also stops a 50,000-object page
      const dflt = await backend.listPageObjects(doc, 1);
      expect(dflt.truncated).toBe(true);
      expect(dflt.objects.length).toBeLessThan(50_000);
    });
  }, SLOW);

  it('getTextRuns gives one run per text object with its font size and char range', async () => {
    const bytes = await generated('objects.pdf', OBJECTS_HINT);
    await withDoc(bytes, async (doc) => {
      const runs = await backend.getTextRuns(doc, 0);
      expect(runs).toHaveLength(44); // the generator calls drawText 44 times on page 1
      const caption = runs.find((r) => r.text === 'Figure 1: A photo.')!;
      expect(caption, 'the caption of Figure 1').toBeDefined();
      expect(caption.fontSize).toBeCloseTo(9, 1);
      expect(caption.charCount).toBe('Figure 1: A photo.'.length);
      expect(await backend.getTextRange(doc, 0, caption.charStart, caption.charCount)).toBe(caption.text);
      expect(caption.rect.x).toBeCloseTo(72, 0);
      // The file has no /Widths, so the advance is that of whatever font replaces Helvetica (Phase 0 measured 74.9 pt; Helvetica's
      // own metrics give 71.5): only the order of magnitude is pinned.
      const helvetica = await helveticaWidth(caption.text, 9);
      expect(caption.rect.width).toBeGreaterThan(helvetica * 0.9);
      expect(caption.rect.width).toBeLessThan(helvetica * 1.15);
      // text top 242 pt from the page top + Helvetica ascent 0.718 x 9 = the baseline at 248.46 pt
      const baseline = 242 + 0.718 * 9;
      expect(caption.rect.y).toBeLessThan(baseline);
      expect(caption.rect.y + caption.rect.height).toBeGreaterThan(baseline);
      expect(caption.rect.height).toBeLessThan(20);
    });
  }, SLOW);

  it('getStructTree gives the alt text of a tagged figure', async () => {
    // tagged.pdf is Chromium's tagged print of <figure><img alt="Bar chart of test scores"> ... (P0-10).
    const bytes = await generated('tagged.pdf', 'Run `pnpm -C spikes/phase0 fixtures:objects` (or the ported scripts/fixtures/make-tagged.mjs).');
    await withDoc(bytes, async (doc) => {
      const roots = await backend.getStructTree(doc, 0);
      const all: { type: string; altText: string | null; markedContentIds: number[] }[] = [];
      const walk = (els: typeof roots) => els.forEach((e) => (all.push(e), walk(e.children)));
      walk(roots);
      expect(all.map((e) => e.type)).toEqual(expect.arrayContaining(['Figure']));
      const fig = all.find((e) => e.altText === 'Bar chart of test scores');
      expect(fig, 'a Figure element with the alt text').toBeDefined();
      expect(fig!.type).toBe('Figure');
      expect(fig!.markedContentIds.length).toBeGreaterThan(0);
      // PDFium returns '' for a missing /Alt; the interface says that reads as null
      expect(all.filter((e) => e.altText === '')).toEqual([]);
    });
  }, SLOW);
});

// =================================================================================================================
// Crashes, hangs and the worker count. These start their own backends and drive the Worker through the spy.

describe('worker failures', () => {
  const heavyReq = { pageIndex: 0, scale: 4, viewRotation: 0 as const, withAnnotations: false };

  /** The workers a backend started: spawned since `from`. */
  const since = (from: number) => spy.spawned.slice(from);

  it('uses ENGINE_WORKERS workers by default: exactly one', async () => {
    const before = spy.spawned.length;
    const be = createEmbedPdfBackend(ASSETS);
    try {
      await withDoc(textPdf.bytes, async (doc) => {
        const bmp = await be.renderTile(doc, { pageIndex: 0, scale: 1, viewRotation: 0, withAnnotations: false });
        bmp.close();
        await be.getPageGlyphs(doc, 0);
      }, be);
      expect(since(before)).toHaveLength(1);
    } finally {
      (be as { dispose?: () => void }).dispose?.();
      since(before).forEach((w) => w.terminate());
    }
  }, SLOW);

  it('a slow render is not mistaken for a hang', async () => {
    const be = createEmbedPdfBackend(ASSETS);
    const before = spy.spawned.length;
    try {
      await withDoc(await buildHeavyPdf(150_000), async (doc) => {
        const t0 = performance.now();
        const bmp = await be.renderTile(doc, { ...heavyReq, scale: 6 }); // about 20 megapixels
        expect(bmp.width).toBeGreaterThan(3000);
        bmp.close();
        console.info(`slow render took ${Math.round(performance.now() - t0)} ms`);
      }, be);
      expect(since(before), 'no restart for a healthy worker').toHaveLength(1);
    } finally {
      since(before).forEach((w) => w.terminate());
    }
  }, SLOW);

  it('a crashed worker rejects every pending call', async () => {
    const before = spy.spawned.length;
    const be = createEmbedPdfBackend(ASSETS);
    try {
      const info = await be.open(copyOf(await buildHeavyPdf()));
      const mine = since(before);
      expect(mine.length).toBeGreaterThanOrEqual(1);

      // A queue of renders keeps the single worker busy, so most of these are pending when the crash arrives.
      const settledEarly: boolean[] = [];
      const calls = Array.from({ length: 14 }, (_, k) => {
        const p = k % 3 === 2 ? be.getPageGlyphs(info.doc, 0) : be.renderTile(info.doc, heavyReq);
        settledEarly[k] = false;
        p.then(() => (settledEarly[k] = true), () => (settledEarly[k] = true));
        return p;
      });
      await sleep(15);
      for (const w of mine) w.dispatchEvent(new ErrorEvent('error', { message: 'simulated worker crash', error: new Error('simulated worker crash') }));
      const doneAtCrash = [...settledEarly];
      expect(doneAtCrash.filter((done) => !done).length, 'the test needs calls in flight when the worker dies').toBeGreaterThanOrEqual(3);

      const results = await Promise.race([Promise.allSettled(calls), sleep(10_000).then(() => 'timeout' as const)]);
      expect(results, 'a pending call was left hanging after the crash').not.toBe('timeout');
      (results as PromiseSettledResult<unknown>[]).forEach((r, k) => {
        if (doneAtCrash[k]) return;
        expect(r.status, `call ${k} was pending when the worker crashed`).toBe('rejected');
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      });
    } finally {
      since(before).forEach((w) => w.terminate());
    }
  }, SLOW);

  it('the backend recovers after a crash: a new open works on a fresh worker', async () => {
    const before = spy.spawned.length;
    const be = createEmbedPdfBackend(ASSETS);
    try {
      const first = await be.open(copyOf(textPdf.bytes));
      const crashed = since(before);
      const call = be.getPageGlyphs(first.doc, 0).then(() => null, (e: unknown) => e);
      for (const w of crashed) w.dispatchEvent(new ErrorEvent('error', { message: 'simulated worker crash', error: new Error('simulated worker crash') }));
      await call;
      // The handle belonged to the dead worker; a document opened now lives in the new one.
      await withDoc(textPdf.bytes, async (doc) => expect(norm(await be.getPageText(doc, 0))).toBe(textPdf.flat), be);
      expect(since(before).length, 'a replacement worker was started').toBeGreaterThanOrEqual(2);
    } finally {
      since(before).forEach((w) => w.terminate());
    }
  }, VERY_SLOW);

  // The watchdog's period is not in the spec. GUESS: a worker that stops answering is detected and the call rejected within
  // 45 s. The hang is simulated by making the Worker object swallow every message posted to it (no heartbeat gets through
  // either), which is what a worker stuck in an endless loop or killed by the out-of-memory handler looks like from outside.
  it('a hung worker is detected by the watchdog, the call rejects, and the backend recovers', async () => {
    const before = spy.spawned.length;
    const be = createEmbedPdfBackend(ASSETS);
    try {
      const first = await be.open(copyOf(textPdf.bytes));
      const original = since(before);
      for (const w of original) w.hung = true;

      const t0 = performance.now();
      const err = await be.getPageText(first.doc, 0).then(() => null, (e: unknown) => e);
      const waited = performance.now() - t0;
      expect(err, 'the call to a hung worker must reject, not hang or answer').toBeInstanceOf(Error);
      expect(waited, `watchdog took ${Math.round(waited)} ms`).toBeLessThan(45_000);

      // Recovery: the next open runs on a new worker and the old one is shut down.
      await withDoc(textPdf.bytes, async (doc, info) => {
        expect(info.pageCount).toBe(1);
        expect(norm(await be.getPageText(doc, 0))).toBe(textPdf.flat);
      }, be);
      expect(since(before).length, 'a replacement worker was started').toBeGreaterThanOrEqual(2);
      expect(original.every((w) => w.terminated), 'the hung worker was terminated').toBe(true);
    } finally {
      since(before).forEach((w) => w.terminate());
    }
  }, VERY_SLOW);
});
