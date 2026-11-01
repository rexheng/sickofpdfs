// Spec-blind PDF builders for the Phase 2 anchoring (S3) and mark geometry (S7) tests. Everything is generated with
// pdf-lib, so the expected text and positions come from the generator and never from the engine under test.
//
// - stampPdf: what a download site does. It adds one line to a real PDF, before the page's own text (a header, so every
//   later char index moves) or after it (a footer, so earlier indices stay).
// - typesetPdf: prose set line by line, one text object per line, as LaTeX does it. The same paragraphs set at two
//   widths are two "reflows" of one text.
// - setPdfRotation: the same PDF with every page's /Rotate set. bigTextPdf: one line of big text at a known place, on a page
//   that may be turned or cropped (its ink is easy to find in a render).
import { PDFArray, PDFDocument, PDFName, PDFNumber, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';

export type Where = 'header' | 'footer';

/** The kind of line JSTOR and similar sites print on every page. */
export const DOWNLOAD_STAMP = 'This content downloaded from 128.40.12.7 on Tue, 14 Mar 2023 10:22:41 UTC';

/**
 * Adds `line` to every page (or to `pages`, 0-based). A header goes first in the page's content, so PDFium reads it
 * first and every later char index moves by line.length + 2 (its CR LF). A footer goes last, so nothing before it moves.
 */
export async function stampPdf(bytes: Uint8Array, o: { where: Where; line?: string; pages?: number[] }): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const line = o.line ?? DOWNLOAD_STAMP;
  doc.getPages().forEach((page, i) => {
    if (o.pages && !o.pages.includes(i)) return;
    const { height } = page.getSize();
    page.drawText(line, { x: 20, y: o.where === 'header' ? height - 14 : 10, size: 7, font, color: rgb(0.3, 0.3, 0.3) });
    if (o.where === 'header') {
      // drawText appends a content stream; move it to the front.
      const streams = page.node.Contents() as PDFArray;
      const last = streams.get(streams.size() - 1);
      streams.remove(streams.size() - 1);
      streams.insert(0, last);
    }
  });
  return doc.save();
}

export interface TypesetOptions {
  /** Greedy word wrap at this many chars. Default 70. */
  wrapAt?: number;
  fontSize?: number;
  leading?: number;
  /** Page margin in points. Default 60. */
  margin?: number;
  page?: [width: number, height: number];
  /** 2: fill the left column top to bottom, then the right one (the order a LaTeX two-column page is read in). */
  columns?: 1 | 2;
  /** Two columns only. 'column' draws the left column, then the right one. 'row' draws left line 1, right line 1, left line 2 ... */
  order?: 'column' | 'row';
}

/** Greedy word wrap, the way a typesetter breaks a paragraph. */
export function wrapParagraph(text: string, wrapAt: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > wrapAt) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines;
}

export interface SetLine {
  text: string;
  page: number;
  column: 0 | 1;
  /** Line number within its column of that page. */
  row: number;
  /** Where the line's left edge and baseline were put: points from the left and the bottom of the page. */
  x: number;
  baseline: number;
  paragraph: number;
}

export interface TypesetResult {
  bytes: Uint8Array;
  /** The lines in drawing order. */
  lines: SetLine[];
}

/** Sets the paragraphs line by line (one text object per line) in Helvetica. */
export async function typesetPdf(paragraphs: string[], o: TypesetOptions = {}): Promise<TypesetResult> {
  const { wrapAt = 70, fontSize = 11, leading = 14, margin = 60, page: size = [612, 792], columns = 1, order = 'column' } = o;
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font: PDFFont = await doc.embedFont(StandardFonts.Helvetica);
  const gutter = 24;
  const colWidth = columns === 2 ? (size[0] - 2 * margin - gutter) / 2 : size[0] - 2 * margin;
  const laid: SetLine[] = [];
  let pageNo = 0;
  let column: 0 | 1 = 0;
  let row = 0;
  let y = size[1] - margin;
  const advance = () => {
    if (columns === 2 && column === 0) column = 1;
    else {
      pageNo++;
      column = 0;
    }
    row = 0;
    y = size[1] - margin;
  };
  paragraphs.forEach((para, pi) => {
    for (const text of wrapParagraph(para, wrapAt)) {
      if (y < margin) advance();
      laid.push({ text, page: pageNo, column, row, x: margin + column * (colWidth + gutter), baseline: y, paragraph: pi });
      y -= leading;
      row++;
    }
    y -= leading / 2; // a little space between paragraphs
    row++; // the space is half a line; count it as one so that the two columns' rows still pair up
  });
  const drawn = order === 'row' && columns === 2 ? [...laid].sort((a, b) => a.page - b.page || a.row - b.row || a.column - b.column) : laid;
  const pages: PDFPage[] = [];
  for (let i = 0; i <= pageNo; i++) pages.push(doc.addPage(size));
  for (const l of drawn) pages[l.page].drawText(l.text, { x: l.x, y: l.baseline, size: fontSize, font, color: rgb(0, 0, 0) });
  return { bytes: await doc.save(), lines: drawn };
}

/** The same document with every page's /Rotate set to `rotate` (the content is not touched). */
export async function setPdfRotation(bytes: Uint8Array, rotate: 0 | 90 | 180 | 270): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  for (const p of doc.getPages()) p.setRotation(degrees(rotate));
  return doc.save();
}

/** One page of big black text on a blank page, at a known place: the ink is easy to find in a render. */
export async function bigTextPdf(o: { text: string; x: number; baselineFromBottom: number; size: number; page?: [number, number]; rotate?: 0 | 90 | 180 | 270; cropBox?: [number, number, number, number] }): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(o.page ?? [612, 792]);
  page.drawText(o.text, { x: o.x, y: o.baselineFromBottom, size: o.size, font, color: rgb(0, 0, 0) });
  if (o.rotate) page.setRotation(degrees(o.rotate));
  if (o.cropBox) {
    const [x0, y0, x1, y1] = o.cropBox;
    page.node.set(PDFName.of('CropBox'), doc.context.obj([PDFNumber.of(x0), PDFNumber.of(y0), PDFNumber.of(x1), PDFNumber.of(y1)]));
  }
  return doc.save();
}
