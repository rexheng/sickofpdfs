// Spec-blind browser tests for mark geometry on a real engine (S7): the rectangles the engine gives, the conversions in
// geometry.ts, and what is painted. The page is drawn by the engine itself, so the pixels are the oracle: a mark must land
// on the ink it is meant for, at every turn of the page.
//
// Sources: the plan's S7 (conversions "at any rotation", "crop box", "One SVG path per style and colour, so overlaps never
// darken"), PageSize in the backend types (the page is shown turned by /Rotate plus the viewer's rotation, clockwise;
// width and height are the unrotated crop box), and R44 (no darker bands where lines meet).
// Function names and call shapes are guessed in p2-geometry-api.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifier, copyOf, measureInk, readPixels } from '../../test/spec-blind/browser-helpers';
import { expectedCss, markPaths, normToCss, pdfRectToNorm } from '../../test/spec-blind/p2-geometry-api';
import type { NormRect, PaintMark, View } from '../../test/spec-blind/p2-geometry-api';
import { bigTextPdf, typesetPdf } from '../../test/spec-blind/p2-pdf-fixtures';
import { PAPER_PARAGRAPHS } from '../../../core/test/spec-blind/anchoring-fixtures';
import { engineAssets } from '../backend/embedpdf/assets';
import { createEmbedPdfBackend } from '../backend/embedpdf/backend';
import type { PdfBackend, Rotation } from '../backend/types';
import { createPageTextProvider } from '../text/page-text';

const ASSETS = engineAssets((path) => new URL(`/apps/extension/public/${path}`, globalThis.location.href).href);
const SLOW = 90_000;

let backend: PdfBackend;
beforeAll(() => {
  backend = createEmbedPdfBackend(ASSETS);
});
afterAll(() => {
  (backend as { dispose?: () => void }).dispose?.();
});

async function open(bytes: Uint8Array) {
  const info = await backend.open(copyOf(bytes));
  return { ...info, text: createPageTextProvider(backend, info.doc) };
}

describe('the crop box', () => {
  it('a page whose crop box is smaller than its media box: rects and norms are relative to the crop box', async () => {
    // Media box 612 x 792. Crop box x 50..450, y 100..700 (from the bottom): the page is 400 x 600 pt, and its top edge is at y = 700.
    // "HELLO WORLD", 40 pt, starts at x = 100 on the baseline y = 600: 50 pt in from the left of the crop box, 100 pt below its top.
    const pdf = await bigTextPdf({ text: 'HELLO WORLD', x: 100, baselineFromBottom: 600, size: 40, cropBox: [50, 100, 450, 700] });
    const info = await open(pdf);
    try {
      expect(info.pages[0], 'the page is the crop box').toMatchObject({ width: 400, height: 600 });
      const text = await info.text.text(0);
      const rects = await info.text.rects(0, 0, text.length);
      expect(rects).toHaveLength(1);
      const norm = pdfRectToNorm(rects[0], info.pages[0]);
      // by construction: the text starts 50 pt in from the left of the crop box (a hair more for the glyph's side bearing), and its baseline is 100 pt down
      expect(norm[0]).toBeGreaterThanOrEqual(50 / 400 - 0.002);
      expect(norm[0]).toBeLessThan(50 / 400 + 0.02);
      expect(Math.abs(norm[3] - 100 / 600)).toBeLessThan(0.01);
      expect(norm[1], 'the top is a cap height above the baseline').toBeGreaterThan((100 - 40 * 0.8) / 600);
      expect(norm[1]).toBeLessThan((100 - 40 * 0.65) / 600);
      // and the engine's own drawing agrees on the right-hand edge, which depends on the font the engine substitutes
      const bitmap = await backend.renderTile(info.doc, { pageIndex: 0, scale: 1, viewRotation: 0, withAnnotations: false });
      expect([bitmap.width, bitmap.height], 'the render is the crop box').toEqual([400, 600]);
      const ink = measureInk(readPixels(bitmap)).box!;
      expect(Math.abs(norm[0] - ink.left / 400)).toBeLessThan(0.01);
      expect(Math.abs(norm[2] - ink.right / 400)).toBeLessThan(0.01);
      expect(Math.abs(norm[1] - ink.top / 600)).toBeLessThan(0.01);
      expect(Math.abs(norm[3] - ink.bottom / 600)).toBeLessThan(0.01);
    } finally {
      await backend.close(info.doc);
    }
  }, SLOW);
});

describe('marks land on the ink at every turn of the page', () => {
  const SCALE = 1.5; // device px per point

  // [the page's /Rotate, the viewer's own turn]
  const TURNS: [Rotation, Rotation][] = [[0, 0], [90, 0], [180, 0], [270, 0], [0, 90], [0, 180], [0, 270], [90, 90], [270, 180]];

  it.each(TURNS)('/Rotate %i and a viewer turn of %i: the converted rectangle holds the drawn text and hugs it', async (rotate, viewRotation) => {
    const pdf = await bigTextPdf({ text: 'HELLO WORLD', x: 100, baselineFromBottom: 600, size: 40, rotate });
    const info = await open(pdf);
    try {
      const text = await info.text.text(0);
      const rects = await info.text.rects(0, 0, text.length);
      const page = info.pages[0];
      expect(page).toMatchObject({ rotation: rotate });
      const css = normToCss(pdfRectToNorm(rects[0], page), { width: page.width, height: page.height, rotation: page.rotation, scale: SCALE, viewRotation });

      const bitmap = await backend.renderTile(info.doc, { pageIndex: 0, scale: SCALE, viewRotation, withAnnotations: false });
      const ink = measureInk(readPixels(bitmap)).box;
      expect(ink, 'the page has ink').not.toBeNull();
      const tol = 3; // px: the engine's rectangle is the glyph boxes, the ink is anti-aliased
      expect(Math.abs(css.x - ink!.left), 'left edge').toBeLessThanOrEqual(tol);
      expect(Math.abs(css.y - ink!.top), 'top edge').toBeLessThanOrEqual(tol);
      expect(Math.abs(css.x + css.width - ink!.right), 'right edge').toBeLessThanOrEqual(tol);
      expect(Math.abs(css.y + css.height - ink!.bottom), 'bottom edge').toBeLessThanOrEqual(tol);
      // and the shown page is the size the turn says
      const turned = ((rotate + viewRotation) % 180) === 90;
      expect(bitmap.width).toBe(Math.round((turned ? page.height : page.width) * SCALE));
    } finally {
      await backend.close(info.doc);
    }
  }, SLOW);
});

describe('painting', () => {
  /** Draws SVG paths on a transparent canvas and reads back alpha, row by row. */
  async function paint(paths: { d: string }[], width: number, height: number, fill = 'rgba(255, 180, 0, 0.5)'): Promise<{ alpha: (x: number, y: number) => number; data: Uint8ClampedArray }> {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${paths.map((p) => `<path d="${p.d}" fill="${fill}"/>`).join('')}</svg>`;
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(img.src);
    const data = ctx.getImageData(0, 0, width, height).data;
    return { alpha: (x, y) => data[4 * (y * width + x) + 3], data };
  }

  const VIEW: View = { width: 200, height: 100, rotation: 0, scale: 2, viewRotation: 0 };

  it('highlights that overlap are one path, so the overlap is no darker than the rest', async () => {
    const A: NormRect = [0.1, 0.2, 0.6, 0.5];
    const B: NormRect = [0.4, 0.3, 0.9, 0.7]; // overlaps A over x 0.4..0.6, y 0.3..0.5
    const marks: PaintMark[] = [
      { id: 'a', style: 'highlight', color: 1, rects: [A] },
      { id: 'b', style: 'highlight', color: 1, rects: [B] },
    ];
    const paths = markPaths(marks, VIEW).filter((p) => p.style === 'highlight' && p.color === 1);
    expect(paths, 'one path for highlight/colour 1').toHaveLength(1);
    const img = await paint(paths, 400, 200);
    const a = expectedCss(A, VIEW, 0);
    const b = expectedCss(B, VIEW, 0);
    const onlyA = img.alpha(Math.round(a.x + 20), Math.round(a.y + 5));
    const onlyB = img.alpha(Math.round(b.x + b.width - 20), Math.round(b.y + b.height - 5));
    const both = img.alpha(Math.round((b.x + a.x + a.width) / 2), Math.round((b.y + a.y + a.height) / 2)); // inside the overlap
    expect(onlyA).toBeGreaterThan(100);
    expect(Math.abs(onlyA - onlyB)).toBeLessThanOrEqual(2);
    expect(Math.abs(both - onlyA), `overlap alpha ${both} against ${onlyA}`).toBeLessThanOrEqual(2);
  }, SLOW);

  it('a different colour is a different path', () => {
    const paths = markPaths(
      [
        { id: 'a', style: 'highlight', color: 1, rects: [[0.1, 0.2, 0.6, 0.5]] },
        { id: 'b', style: 'highlight', color: 3, rects: [[0.4, 0.3, 0.9, 0.7]] },
      ],
      VIEW,
    );
    expect(paths.map((p) => `${p.style}/${String(p.color)}`).sort()).toEqual(['highlight/1', 'highlight/3']);
  });

  it('lines set at the leading of their type size meet without a darker band or a seam', async () => {
    // 11 pt type on 11 pt leading: the engine's rectangles of neighbouring lines touch (or overlap by a hair)
    const { bytes } = await typesetPdf(PAPER_PARAGRAPHS[1], { wrapAt: 74, fontSize: 11, leading: 11 });
    const info = await open(bytes);
    try {
      const text = await info.text.text(0);
      const rects = await info.text.rects(0, 0, text.length);
      const page = info.pages[0];
      const marks: PaintMark[] = [{ id: 'm', style: 'highlight', color: 1, rects: rects.map((r) => pdfRectToNorm(r, page)) }];
      const view: View = { width: page.width, height: page.height, rotation: page.rotation, scale: 1.5, viewRotation: 0 };
      const paths = markPaths(marks, view);
      expect(paths).toHaveLength(1);
      const w = Math.round(page.width * 1.5);
      const h = Math.round(page.height * 1.5);
      const img = await paint(paths, w, h);

      // Where two lines of one paragraph meet, look down a column through both: it is one even band, with no dark line or light seam
      const boxes = marks[0].rects.map((r) => expectedCss(r, view, 0));
      let met = 0;
      for (let i = 0; i + 1 < boxes.length; i++) {
        const a = boxes[i];
        const b = boxes[i + 1];
        if (b.y - (a.y + a.height) > 1) continue; // a paragraph break, not a line break
        const x = Math.round((Math.max(a.x, b.x) + Math.min(a.x + a.width, b.x + b.width)) / 2);
        const column: number[] = [];
        for (let y = Math.ceil(a.y) + 2; y < Math.floor(b.y + b.height) - 2; y++) column.push(img.alpha(x, y));
        const base = column.slice().sort((p, q) => p - q)[Math.floor(column.length / 2)];
        expect(base, `lines ${i} and ${i + 1} are painted`).toBeGreaterThan(100);
        expect(Math.max(...column) - base, `no darker band where lines ${i} and ${i + 1} meet`).toBeLessThanOrEqual(2);
        expect(base - Math.min(...column), `no light seam where lines ${i} and ${i + 1} meet`).toBeLessThanOrEqual(2);
        met++;
      }
      expect(met, 'precondition: several pairs of lines meet').toBeGreaterThanOrEqual(3);
    } finally {
      await backend.close(info.doc);
    }
  }, SLOW);

  it('a real two-column page: marks over a range that crosses the columns paint two bands that do not touch', async () => {
    const info = await open(await classifier('learning/arxiv-1512.03385-resnet.pdf'));
    try {
      const page = info.pages[0];
      const glyphs = (await info.text.glyphs(0)).glyphs.filter((g) => !g.generated);
      const jump = glyphs.find((g, i) => i > 0 && g.box.x > 305 && glyphs[i - 1].box.x + glyphs[i - 1].box.width < 290 && g.box.y < glyphs[i - 1].box.y - 200);
      expect(jump, 'precondition: reading jumps from the left column to the right').toBeDefined();
      const rects = await info.text.rects(0, jump!.index - 160, 400);
      const norm = rects.map((r) => pdfRectToNorm(r, page));
      const view: View = { width: page.width, height: page.height, rotation: 0, scale: 1, viewRotation: 0 };
      const paths = markPaths([{ id: 'm', style: 'highlight', color: 1, rects: norm }], view);
      const img = await paint(paths, Math.round(page.width), Math.round(page.height));
      // the gutter (x 292..304) is clear at every height
      for (let y = 0; y < Math.round(page.height); y += 3) for (let x = 292; x <= 304; x += 4) expect(img.alpha(x, y), `gutter pixel ${x},${y}`).toBe(0);
      // and both columns have paint
      let left = 0;
      let rightSide = 0;
      for (let y = 0; y < Math.round(page.height); y++) {
        if (img.alpha(150, y) > 100) left++;
        if (img.alpha(420, y) > 100) rightSide++;
      }
      expect(left).toBeGreaterThan(10);
      expect(rightSide).toBeGreaterThan(10);
    } finally {
      await backend.close(info.doc);
    }
  }, SLOW);
});

