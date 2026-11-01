// Spec-blind test data for the PdfBackend tests. Everything here is built from first principles with pdf-lib (or by
// hand), so the expected values (page sizes, text, positions, field kinds) come from the generator, never from the
// engine under test. Runs in the browser and in Node (node --experimental-strip-types) so the generated files can be
// cross-checked with another PDFium build.
import { PDFBool, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts, beginText, degrees, endText, moveText, rgb, setFontAndSize, showText } from 'pdf-lib';

export interface PageSpec {
  width: number;
  height: number;
  /** The page's /Rotate. */
  rotate?: 0 | 90 | 180 | 270;
  /** Black text "Page N" is drawn so the page is never blank. */
  text?: boolean;
}

export interface MetaSpec {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
}

/** A document with the given pages (all with a visible "Page N" label) and optional /Info entries. */
export async function buildPagesPdf(pages: PageSpec[], meta: MetaSpec = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  if (meta.title !== undefined) doc.setTitle(meta.title);
  if (meta.author !== undefined) doc.setAuthor(meta.author);
  if (meta.subject !== undefined) doc.setSubject(meta.subject);
  if (meta.keywords !== undefined) doc.setKeywords(meta.keywords);
  if (meta.creator !== undefined) doc.setCreator(meta.creator);
  if (meta.producer !== undefined) doc.setProducer(meta.producer);
  pages.forEach((spec, i) => {
    const page = doc.addPage([spec.width, spec.height]);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    if (spec.text !== false) page.drawText(`Page ${i + 1}`, { x: 36, y: spec.height - 60, size: 24, font, color: rgb(0, 0, 0) });
  });
  return doc.save();
}

/** One page, no content at all. */
export async function buildBlankPdf(width = 612, height = 792): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([width, height]);
  return doc.save();
}

// ---------------------------------------------------------------------------------------------------------------
// Text with known positions

export interface KnownLine {
  text: string;
  /** Left edge of the first glyph, points from the page's left edge. */
  x: number;
  /** The baseline, points from the page's TOP edge. */
  baseline: number;
}

export interface KnownChar {
  ch: string;
  /** Index of the char in the line. */
  at: number;
  line: number;
  /** Expected left edge and advance, points from the page's left edge (pure font metrics, no kerning). */
  x: number;
  advance: number;
  baseline: number;
}

export const TEXT_PAGE = { width: 612, height: 792, fontSize: 14 } as const;

export const TEXT_LINES: readonly KnownLine[] = [
  { text: 'Alpha beta gamma delta epsilon', x: 72, baseline: 100 },
  { text: 'Zeta eta theta iota kappa', x: 72, baseline: 140 },
  { text: 'Lambda mu nu xi omicron', x: 72, baseline: 180 },
];

export interface TextPdf {
  bytes: Uint8Array;
  lines: readonly KnownLine[];
  /** Every visible character with its expected x extent. */
  chars: KnownChar[];
  /** The three lines joined by single spaces (what a reader would copy once whitespace is collapsed). */
  flat: string;
}

/**
 * Page 1: three lines of 14 pt Helvetica at known positions, one text object per line.
 *
 * The font dictionary carries explicit /Widths (Helvetica's, in 1/1000 em), so every glyph advance in the file is known
 * and does not depend on which substitute font the engine draws with: the engine has no system fonts and uses bundled
 * ones, and a Helvetica without /Widths takes its advances from whatever font replaces it. That holds for advances only:
 * a glyph's ink can overhang its advance (Noto Sans "t", "k", "r" by up to 0.9 pt at 14 pt), and PDFium's loose box then
 * extends to the ink, so box widths still depend on the substitute font.
 */
export async function buildTextPdf(): Promise<TextPdf> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const metrics = await doc.embedFont(StandardFonts.Helvetica); // only used for the widths
  const advance = (ch: string, size: number) => metrics.widthOfTextAtSize(ch, size);
  const widths = Array.from({ length: 95 }, (_, k) => Math.round(advance(String.fromCharCode(32 + k), 1000)));
  const fontRef = doc.context.register(
    doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding', FirstChar: 32, LastChar: 126, Widths: widths }),
  );
  const page = doc.addPage([TEXT_PAGE.width, TEXT_PAGE.height]);
  page.node.setFontDictionary(PDFName.of('F1'), fontRef);
  const chars: KnownChar[] = [];
  TEXT_LINES.forEach((line, li) => {
    page.pushOperators(beginText(), setFontAndSize('F1', TEXT_PAGE.fontSize), moveText(line.x, TEXT_PAGE.height - line.baseline), showText(PDFHexString.of(Array.from(line.text, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''))), endText());
    let x = line.x;
    [...line.text].forEach((ch, at) => {
      // The advance the file declares: /Widths rounded to whole 1/1000 em, times the size.
      const w = (Math.round(advance(ch, 1000)) * TEXT_PAGE.fontSize) / 1000;
      chars.push({ ch, at, line: li, x, advance: w, baseline: line.baseline });
      x += w;
    });
  });
  return { bytes: await doc.save(), lines: TEXT_LINES, chars, flat: TEXT_LINES.map((l) => l.text).join(' ') };
}

// ---------------------------------------------------------------------------------------------------------------
// A page that keeps the worker busy (used to have calls pending when a crash is injected)

/** One Letter page of `rects` filled rectangles, written straight into the content stream. */
export async function buildHeavyPdf(rects = 60_000): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const cols = 300;
  const ops = ['0.2 0.2 0.2 rg'];
  for (let k = 0; k < rects; k++) {
    const x = 36 + (k % cols) * (540 / cols);
    const y = 36 + Math.floor(k / cols) * (720 / (rects / cols));
    ops.push(`${x.toFixed(3)} ${y.toFixed(3)} 1.2 1.2 re f`);
  }
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(ops.join('\n'))));
  return doc.save({ useObjectStreams: false });
}

// ---------------------------------------------------------------------------------------------------------------
// Forms. The kinds mirror what the Phase 0 form check pinned down on PDFium (report: P0-7).

export type FormKind = 'textfield' | 'checkbox' | 'radiobutton' | 'combobox' | 'listbox' | 'signature-only' | 'empty-acroform' | 'links-only';

const BOX = { x: 72, y: 650, width: 200, height: 28 };

/**
 * Fillable kinds put a push button on page 1 (index 0) and the field on page 2 (index 1), so the first fillable page is 1
 * and the push button must not count. 'signature-only' has the push button and a signature field (no fillable field).
 * 'empty-acroform' is what hyperref writes: three pages, an /AcroForm with no fields. 'links-only' has link annotations
 * and no /AcroForm.
 */
export async function buildFormPdf(kind: FormKind): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  if (kind === 'empty-acroform') {
    for (let k = 0; k < 3; k++) doc.addPage([612, 792]).drawText(`Page ${k + 1}`, { x: 72, y: 700, size: 18, font });
    doc.getForm(); // creates the empty /AcroForm
    return { bytes: await doc.save(), pageCount: 3 };
  }
  const pages = [doc.addPage([612, 792]), doc.addPage([612, 792])];
  pages.forEach((p, k) => p.drawText(`Page ${k + 1}`, { x: 72, y: 740, size: 18, font }));
  if (kind === 'links-only') {
    for (const [k, p] of pages.entries()) {
      const link = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [72, 600, 272, 620],
        Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of(`https://example.org/${k}`) },
      });
      p.node.addAnnot(doc.context.register(link));
    }
    return { bytes: await doc.save(), pageCount: 2 };
  }
  const form = doc.getForm();
  form.createButton('go').addToPage('Go', pages[0], BOX);
  switch (kind) {
    case 'textfield':
      form.createTextField('name').addToPage(pages[1], BOX);
      break;
    case 'checkbox':
      form.createCheckBox('agree').addToPage(pages[1], BOX);
      break;
    case 'radiobutton': {
      const group = form.createRadioGroup('choice');
      group.addOptionToPage('a', pages[1], BOX);
      group.addOptionToPage('b', pages[1], { ...BOX, y: 600 });
      break;
    }
    case 'combobox': {
      const box = form.createDropdown('country');
      box.addOptions(['UK', 'US']);
      box.addToPage(pages[1], BOX);
      break;
    }
    case 'listbox': {
      const list = form.createOptionList('colour');
      list.addOptions(['red', 'green']);
      list.addToPage(pages[1], { ...BOX, height: 60 });
      break;
    }
    case 'signature-only': {
      // pdf-lib cannot make a signature field: write the widget by hand and register it as annotation and field.
      const widget = doc.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('sig'), Rect: [72, 600, 272, 660], F: 4, P: pages[1].ref });
      const ref = doc.context.register(widget);
      pages[1].node.addAnnot(ref);
      form.acroForm.addField(ref);
      break;
    }
  }
  return { bytes: await doc.save(), pageCount: 2 };
}

/** An /AcroForm with an /XFA entry (the W-9 shape); `needsRendering` also sets /NeedsRendering true in the catalog. */
export async function buildXfaPdf(needsRendering: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([612, 792]);
  const form = doc.getForm();
  const xdp = doc.context.register(doc.context.stream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>'));
  form.acroForm.dict.set(PDFName.of('XFA'), doc.context.obj([PDFString.of('template'), xdp]));
  if (needsRendering) doc.catalog.set(PDFName.of('NeedsRendering'), PDFBool.True);
  // updateFieldAppearances: false keeps /XFA (by default save() deletes it).
  return doc.save({ updateFieldAppearances: false });
}

// ---------------------------------------------------------------------------------------------------------------
// Links and an outline

export const LINK_RECT = { x: 72, y: 600, width: 200, height: 20 } as const; // pdf-lib (bottom-left) coordinates

/**
 * Three pages. Page 1 has a URI link at LINK_RECT and a link to page 3 whose destination is /XYZ 100 500 (left, top in
 * bottom-left page space). The outline is: "Chapter 1" (page 1) > "Section 1.1" (page 2); "Chapter 2" (page 3).
 */
export async function buildNavigationPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [0, 1, 2].map((k) => {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${k + 1}`, { x: 72, y: 740, size: 18, font });
    return p;
  });
  const uri = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [LINK_RECT.x, LINK_RECT.y, LINK_RECT.x + LINK_RECT.width, LINK_RECT.y + LINK_RECT.height],
    Border: [0, 0, 0],
    A: { S: 'URI', URI: PDFString.of('https://example.org/paper') },
  });
  const goto = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [72, 540, 272, 560],
    Border: [0, 0, 0],
    Dest: [pages[2].ref, PDFName.of('XYZ'), PDFNumber.of(100), PDFNumber.of(500), PDFNumber.of(0)],
  });
  pages[0].node.addAnnot(doc.context.register(uri));
  pages[0].node.addAnnot(doc.context.register(goto));

  // Outline: root -> [Chapter 1 -> [Section 1.1], Chapter 2]
  const root = doc.context.nextRef();
  const ch1 = doc.context.nextRef();
  const sec = doc.context.nextRef();
  const ch2 = doc.context.nextRef();
  const dest = (pageIndex: number) => [pages[pageIndex].ref, PDFName.of('Fit')];
  doc.context.assign(root, doc.context.obj({ Type: 'Outlines', First: ch1, Last: ch2, Count: 3 }));
  doc.context.assign(ch1, doc.context.obj({ Title: PDFString.of('Chapter 1'), Parent: root, Next: ch2, First: sec, Last: sec, Count: 1, Dest: dest(0) }));
  doc.context.assign(sec, doc.context.obj({ Title: PDFString.of('Section 1.1'), Parent: ch1, Dest: dest(1) }));
  doc.context.assign(ch2, doc.context.obj({ Title: PDFString.of('Chapter 2'), Parent: root, Prev: ch1, Dest: dest(2) }));
  doc.catalog.set(PDFName.of('Outlines'), root);
  return doc.save({ useObjectStreams: false });
}

// ---------------------------------------------------------------------------------------------------------------
// The Phase 0 font fixture (spikes/phase0/scripts/make-font-fixture.mjs), rebuilt byte for byte: two fonts that are NOT
// embedded. Only a bundled CJK fallback font can draw the 120 pt 日本語 line, so ink on this page proves the engine found
// its bundled fonts.

export function buildFontFixturePdf(): Uint8Array {
  const ucs2Hex = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join('');
  const content = ['BT /F1 28 Tf 72 700 Td (R\\351sum\\351 na\\357ve) Tj ET', `BT /F2 120 Tf 72 520 Td <${ucs2Hex('日本語')}> Tj ET`].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /TrueType /BaseFont /Calibri /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>',
    '<< /Type /FontDescriptor /FontName /Calibri /Flags 32 /FontBBox [-503 -250 1240 750] /ItalicAngle 0 /Ascent 750 /Descent -250 /CapHeight 632 /StemV 80 >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /MS-Gothic /Encoding /UniJIS-UCS2-H /DescendantFonts [8 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MS-Gothic /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 9 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /MS-Gothic /Flags 4 /FontBBox [0 -141 1000 859] /ItalicAngle 0 /Ascent 859 /Descent -141 /CapHeight 709 /StemV 80 >>',
  ];
  let pdf = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every code point is below 256, so the string is already latin1.
  return Uint8Array.from(pdf, (c) => c.charCodeAt(0));
}
