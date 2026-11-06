// "Save this page to library" (spec R103): lays the article out as a clean, readable PDF, on this computer.
//
// The text is real PDF text in the bundled Noto fonts (subset into the file), so PDFium's text layer, selection, search,
// Bold word starts and caret browsing work on it as on any PDF. The layout, chosen to read well:
// - A4, or US Letter where Letter is the paper (the locale's region); comfortable margins, an 11 pt body on a 16.5 pt line.
// - Noto Sans, ragged right (no justification and no hyphens: even word spacing reads more easily, as dyslexia style guides
//   advise); Noto Sans Mono for code.
// - Headings, paragraphs, lists, quotes, code blocks, tables, figures with captions, and links that can be clicked.
// - Page 1 starts with the title, the byline and date, and a card with the source link and "Saved on <date>".
// - A heading never ends a page, and a paragraph never leaves a single line at the foot or the head of a page.
// - Headings become the PDF's outline, so the viewer's contents list them.
import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFDocument, type PDFFont, type PDFImage, PDFName, PDFNumber, type PDFPage, PDFString, rgb, type RGB } from 'pdf-lib';
import { type Article, type Block, type ImageRef, type ImageResult, type Inline, textOfRuns } from './article';

export interface TypesetFonts {
  regular: Uint8Array;
  bold: Uint8Array;
  italic: Uint8Array;
  boldItalic: Uint8Array;
  mono: Uint8Array;
}

/** A character none of the fonts has (an emoji, a Chinese name), drawn as a small picture by the page's own fonts. */
export interface GlyphPicture {
  png: Uint8Array;
  /** Its box in em: width, and how far it reaches above and below the baseline. */
  width: number;
  ascent: number;
  descent: number;
}

export interface TypesetInput {
  article: Article;
  /** What reading each picture of the article gave; a picture missing here was not read. */
  images: ReadonlyMap<ImageRef, ImageResult>;
  /** When the owner saved it (Unix ms): page 1 says "Saved on <date>". */
  savedAt: number;
  /** The owner's language, for the dates and the paper size. */
  locale?: string;
  fonts: TypesetFonts;
  /** Draws the characters no font here has. Left out: they are left out of the PDF (and counted). */
  glyphPictures?: (clusters: readonly string[]) => Promise<Map<string, GlyphPicture>>;
}

export interface TypesetResult {
  bytes: Uint8Array;
  pageCount: number;
  /** Pictures of the article that could not be read from the page. Page 1 says how many. */
  missingPictures: number;
}

/** Too many characters no font here has: the page is in a writing system this PDF cannot set (Chinese, Arabic…). */
export class UnsupportedScriptError extends Error {
  constructor() {
    super('unsupported-script: the page is written in letters the bundled fonts do not have');
  }
}

/** More characters than this that need a picture each, and the page is not set at all. */
const MAX_PICTURE_CHARS = 400;

// ---- measures (PDF points) ----

const PAPER = { a4: [595.28, 841.89], letter: [612, 792] } as const;
const MEASURE = 396; // 5.5 in: about 75 characters a line at 11 pt
const WIDE = 468; // figures may use a little more than the text
const TOP = 76;
const BOTTOM = 72;
const BODY = { size: 11, lead: 16.5, after: 8 };
const SMALL = { size: 9, lead: 13 };
const CODE = { size: 9, lead: 13.5, padX: 10, padY: 8 };
const TABLE = { size: 9.5, lead: 13.5, pad: 6 };
const INDENT = 20; // lists and quotes, per level
const HEADINGS: Record<number, { size: number; lead: number; before: number; after: number }> = {
  1: { size: 18, lead: 24, before: 22, after: 8 },
  2: { size: 16, lead: 21, before: 20, after: 6 },
  3: { size: 13, lead: 18, before: 16, after: 4 },
  4: { size: 11.5, lead: 17, before: 14, after: 2 },
  5: { size: 11, lead: 16.5, before: 12, after: 2 },
  6: { size: 11, lead: 16.5, before: 12, after: 2 },
};

// The library's light Drive colours (GM3): text, secondary text, links, outlines and the card surface.
const INK = hex('#1f1f1f');
const INK_2 = hex('#444746');
const INK_3 = hex('#5e5e5e');
const LINK = hex('#0b57d0');
const RULE = hex('#c4c7c5');
const RULE_LIGHT = hex('#e1e3e1');
const SURFACE = hex('#f0f4f9');
const CODE_BG = hex('#f3f5f7');

function hex(h: string): RGB {
  return rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
}

/** Letter in the countries that use it; A4 everywhere else. */
export function paperFor(locale: string | undefined): 'a4' | 'letter' {
  try {
    const region = new Intl.Locale(locale ?? navigator.language).maximize().region ?? '';
    return ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'CR', 'GT', 'PA', 'PR', 'DO', 'SV', 'NI', 'HN', 'BZ'].includes(region) ? 'letter' : 'a4';
  } catch {
    return 'a4';
  }
}

// ---- fonts ----

type FaceName = 'regular' | 'bold' | 'italic' | 'boldItalic' | 'mono';

interface Face {
  pdf: PDFFont;
  has(cp: number): boolean;
}

/** Ligatures off: every glyph is one character, so selection and copying give back exactly the letters. */
const PLAIN_FEATURES = { liga: false, clig: false, dlig: false, calt: false, rlig: false, kern: false };

async function embedFaces(doc: PDFDocument, fonts: TypesetFonts): Promise<Record<FaceName, Face>> {
  doc.registerFontkit(fontkit);
  const face = async (bytes: Uint8Array): Promise<Face> => {
    const coverage = fontkit.create(bytes);
    const pdf = await doc.embedFont(bytes, { subset: true, features: PLAIN_FEATURES });
    return { pdf, has: (cp) => coverage.hasGlyphForCodePoint(cp) };
  };
  const [regular, bold, italic, boldItalic, mono] = await Promise.all([face(fonts.regular), face(fonts.bold), face(fonts.italic), face(fonts.boldItalic), face(fonts.mono)]);
  return { regular, bold, italic, boldItalic, mono };
}

// ---- styled text, measured ----

interface TextStyle {
  face: FaceName;
  size: number;
  color: RGB;
  href?: string;
  /** Raised (superscript) or lowered (subscript), in pt. */
  rise?: number;
  /** Inline code: a light box behind it. */
  codeBox?: boolean;
}

/** The smallest piece of a line: a word (with the space after it) or a picture character. */
interface Piece {
  text: string;
  style: TextStyle;
  /** The face that draws it: the style's, or a fallback that has its letters. */
  face: FaceName;
  width: number;
  /** The width of the space after it (0 when none). */
  space: number;
  /** A line may break after it. */
  breakAfter: boolean;
  /** A picture character instead of text. */
  picture?: GlyphPicture & { key: string };
  /** A hard line break (`<br>`) comes after it. */
  hardBreak?: boolean;
}

interface Line {
  pieces: Piece[];
  width: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Characters that are dropped: soft hyphens, zero-width characters, byte-order marks and controls. */
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff\u0000-\u0008\u000b-\u001f\u007f]/gu;
const CJK = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;

class Measurer {
  private readonly widths = new Map<string, number>();
  constructor(
    private readonly faces: Record<FaceName, Face>,
    private readonly pictures: Map<string, GlyphPicture>,
  ) {}

  width(face: FaceName, text: string, size: number): number {
    const key = `${face}\u0000${size}\u0000${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      w = this.faces[face].pdf.widthOfTextAtSize(text, size);
      this.widths.set(key, w);
    }
    return w;
  }

  /** The face that has every letter of `cluster`: the style's own, then Noto Sans, then Noto Sans Mono; null for none. */
  faceFor(style: FaceName, cluster: string): FaceName | null {
    const cps = Array.from(cluster, (c) => c.codePointAt(0) ?? 0).filter((cp) => cp !== 0xfe0f && cp !== 0xfe0e);
    const order: FaceName[] = style === 'mono' ? ['mono', 'regular'] : [style, 'regular', 'mono'];
    for (const f of order) if (cps.every((cp) => this.faces[f].has(cp))) return f;
    return null;
  }

  /** Splits text into pieces: words with their space, each run of one face, and picture characters. */
  pieces(text: string, style: TextStyle, out: Piece[]): void {
    // Groups of digits stay on one line ("4111 1111 1111 1111", "020 7946 0000"): a number is never split across lines, which
    // also keeps a card or account number whole in the page text, where the save's every-page check (R91) looks for it.
    const clean = text.replace(INVISIBLE, '').replace(/\t/gu, ' ').replace(/(\d) (?=\d)/gu, '$1\u00a0');
    // Words and the spaces after them. A no-break space joins words.
    for (const m of clean.matchAll(/([^ ]+)( *)|( +)/gu)) {
      const word = m[1] ?? '';
      const spaces = (m[2] ?? '') || (m[3] ?? '');
      if (word === '') {
        const last = out[out.length - 1];
        if (last !== undefined && !last.hardBreak) {
          last.space = Math.max(last.space, this.width(last.face, ' ', last.style.size));
          last.breakAfter = true;
        }
        continue;
      }
      this.word(word, style, out);
      const last = out[out.length - 1];
      if (last !== undefined) {
        last.space = spaces === '' ? 0 : this.width(last.face, ' ', style.size);
        last.breakAfter = spaces !== '' || last.breakAfter;
      }
    }
  }

  /**
   * One word: its letters grouped by the face that draws them. A line may break after a hyphen, a dash or a slash, after
   * the dots and marks of a long word (a link), and between Chinese, Japanese or Korean letters.
   */
  private word(word: string, style: TextStyle, out: Piece[]): void {
    const breaks = Array.from(word).length > 18 ? /[/\-–—_.?&=]/u : /[/\-–—]/u;
    const startedAt = out.length;
    let cur: Piece | null = null;
    for (const { segment } of graphemes.segment(word)) {
      const face = segment === '\u00a0' ? style.face : this.faceFor(style.face, segment);
      const cjk = CJK.test(segment);
      if (face === null) {
        cur = null;
        const picture = this.pictures.get(segment);
        if (picture !== undefined) out.push({ text: segment, style, face: style.face, width: picture.width * style.size, space: 0, breakAfter: cjk, picture: { ...picture, key: segment } });
        continue;
      }
      if (cur !== null && cur.face === face && !cjk && !cur.breakAfter) {
        cur.text += segment;
        cur.width = this.width(face, cur.text, style.size);
      } else {
        cur = { text: segment, style, face, width: this.width(face, segment, style.size), space: 0, breakAfter: cjk };
        out.push(cur);
      }
      if (breaks.test(segment)) cur.breakAfter = true;
    }
    // The end of the word is a break point only if a space follows (the caller decides), or between CJK letters.
    const last = out.length > startedAt ? out[out.length - 1] : undefined;
    if (last !== undefined && !CJK.test(last.text)) last.breakAfter = false;
  }

  /** Runs as pieces, in `base` style (bold, italic, code and links on top). */
  runs(runs: readonly Inline[], base: TextStyle): Piece[] {
    const out: Piece[] = [];
    for (const r of runs) {
      if (!('text' in r)) {
        const last = out[out.length - 1];
        if (last !== undefined) {
          last.hardBreak = true;
          last.breakAfter = true;
        }
        continue;
      }
      const bold = r.bold === true || base.face === 'bold' || base.face === 'boldItalic';
      const italic = r.italic === true || base.face === 'italic' || base.face === 'boldItalic';
      const face: FaceName = r.code || base.face === 'mono' ? 'mono' : bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
      const size = r.sup || r.sub ? base.size * 0.7 : r.code && base.face !== 'mono' ? base.size * 0.92 : base.size;
      const style: TextStyle = {
        face,
        size,
        color: r.href !== undefined ? LINK : base.color,
        ...(r.href !== undefined ? { href: r.href } : base.href !== undefined ? { href: base.href } : {}),
        ...(r.sup ? { rise: base.size * 0.36 } : r.sub ? { rise: -base.size * 0.14 } : {}),
        ...(r.code && base.face !== 'mono' ? { codeBox: true } : {}),
      };
      this.pieces(r.text, style, out);
    }
    return out;
  }
}

/** Greedy line breaking for a ragged right edge: as many pieces as fit, breaking only where a break is allowed. */
function breakLines(pieces: readonly Piece[], width: number): Line[] {
  const lines: Line[] = [];
  let line: Piece[] = [];
  let lineWidth = 0;
  // `run` collects the pieces up to the next break point; they go onto a line together.
  let run: Piece[] = [];
  let runWidth = 0;
  const endLine = () => {
    if (line.length === 0) return;
    lines.push({ pieces: line, width: lineWidth - (line[line.length - 1]?.space ?? 0) });
    line = [];
    lineWidth = 0;
  };
  const place = () => {
    if (run.length === 0) return;
    const ink = runWidth - (run[run.length - 1]?.space ?? 0);
    if (line.length > 0 && lineWidth + ink > width) endLine();
    if (line.length === 0 && ink > width) {
      // Longer than a whole line (a long link): split it letter by letter.
      for (const p of splitPieces(run, width)) {
        if (lineWidth + p.width > width && line.length > 0) endLine();
        line.push(p);
        lineWidth += p.width + p.space;
      }
    } else {
      line.push(...run);
      lineWidth += runWidth;
    }
    const hard = run[run.length - 1]?.hardBreak === true;
    run = [];
    runWidth = 0;
    if (hard) endLine();
  };
  for (const p of pieces) {
    run.push(p);
    runWidth += p.width + p.space;
    if (p.breakAfter || p.hardBreak) place();
  }
  place();
  endLine();
  return lines;
}

/** Pieces cut into single letters (keeping each piece's style), for a word wider than a line. */
function splitPieces(run: readonly Piece[], width: number): Piece[] {
  const out: Piece[] = [];
  for (const p of run) {
    if (p.width <= width || p.picture) {
      out.push(p);
      continue;
    }
    const chars = Array.from(graphemes.segment(p.text), (s) => s.segment);
    const per = p.width / Math.max(1, chars.length);
    chars.forEach((c, i) => out.push({ ...p, text: c, width: per, space: i === chars.length - 1 ? p.space : 0, breakAfter: true }));
  }
  return out;
}

// ---- the page boxes ----

/** One horizontal slice of the flow: a line, a picture, a rule. Placed top to bottom, page after page. */
interface Box {
  height: number;
  /** Space above it; none at the top of a page. */
  before: number;
  /** It must be on the same page as the box after it (a heading, a paragraph's first line, a figure's picture). */
  keep?: boolean;
  /** A picture may be drawn smaller, down to this height, to fit the rest of a page rather than leave a gap. */
  minHeight?: number;
  /** A table row: its table's header row, drawn again at the top of a new page. */
  header?: Box;
  /** Drawn with the top of the box at `top` (PDF y, from the bottom of the page), `height` tall (less when shrunk). */
  draw(page: PDFPage, top: number, height: number): void;
  /** Backgrounds and bars that run along several boxes (code blocks, quotes). */
  groups?: readonly Group[];
  /** The heading this box starts, for the outline. */
  outline?: string;
}

interface Group {
  kind: 'code' | 'quote';
  /** Left edge and width of the background (code), or the x of the bar (quote). */
  x: number;
  width: number;
  id: number;
}

let groupIds = 0;

interface Context {
  doc: PDFDocument;
  faces: Record<FaceName, Face>;
  m: Measurer;
  pageWidth: number;
  pageHeight: number;
  /** The left edge of the text measure. */
  left: number;
  /** The article's pictures that were read, embedded once each; a picture missing here is shown as "not copied". */
  pictures: ReadonlyMap<ImageRef, { image: PDFImage; width: number; height: number }>;
  /** The picture characters, by the character. */
  glyphs: ReadonlyMap<string, PDFImage>;
  /** Links to add once the page is known: their rectangles. */
  links: { page: PDFPage; rect: [number, number, number, number]; href: string }[];
}

/** Where the baseline of a line of `size` text sits in a line box of height `lead`: centred as a browser centres it. */
function baselineIn(top: number, lead: number, size: number): number {
  // Noto Sans and Noto Sans Mono: ascender 1.069 em, descender 0.293 em.
  return top - (lead - 1.362 * size) / 2 - 1.069 * size;
}

/** Draws one line of pieces at (x, baseline). Pieces of one face, size, colour and link go out as one run of text. */
function drawLine(ctx: Context, page: PDFPage, line: Line, x: number, baseline: number): void {
  const pieces = line.pieces;
  let cx = x;
  let i = 0;
  while (i < pieces.length) {
    const p = pieces[i];
    const lastOfLine = (k: number) => k === pieces.length - 1;
    if (p.picture) {
      const img = ctx.glyphs.get(p.picture.key);
      const s = p.style.size;
      if (img !== undefined) page.drawImage(img, { x: cx, y: baseline - p.picture.descent * s + (p.style.rise ?? 0), width: p.width, height: (p.picture.ascent + p.picture.descent) * s });
      cx += p.width + (lastOfLine(i) ? 0 : p.space);
      i += 1;
      continue;
    }
    let j = i;
    let text = '';
    let ink = 0;
    let advance = 0;
    while (j < pieces.length) {
      const q = pieces[j];
      const s = p.style;
      if (q.picture || q.face !== p.face || q.style.size !== s.size || q.style.color !== s.color || q.style.href !== s.href || q.style.rise !== s.rise || q.style.codeBox !== s.codeBox) break;
      ink = advance + q.width;
      advance = ink + (lastOfLine(j) ? 0 : q.space);
      text += q.text + (q.space > 0 && !lastOfLine(j) ? ' ' : '');
      j += 1;
    }
    const s = p.style;
    if (s.codeBox) page.drawRectangle({ x: cx - 1.5, y: baseline - s.size * 0.3, width: ink + 3, height: s.size * 1.25, color: SURFACE });
    page.drawText(text.replace(/\u00a0/gu, ' '), { x: cx, y: baseline + (s.rise ?? 0), size: s.size, font: ctx.faces[p.face].pdf, color: s.color });
    if (s.href !== undefined) ctx.links.push({ page, rect: [cx, baseline - s.size * 0.3, cx + ink, baseline + s.size * 0.95], href: s.href });
    cx += advance;
    i = j;
  }
}

/** Lines of text as boxes: a paragraph keeps at least two lines together at the foot and the head of a page. */
function textBoxes(ctx: Context, lines: readonly Line[], o: { x: number; lead: number; size: number; before: number; keepAll?: boolean; groups?: readonly Group[]; outline?: string }): Box[] {
  return lines.map((line, i): Box => {
    const n = lines.length;
    const keep = o.keepAll === true || (n >= 2 && i === 0) || (n >= 3 && i === n - 2);
    return {
      height: o.lead,
      before: i === 0 ? o.before : 0,
      ...(keep ? { keep: true } : {}),
      ...(o.groups ? { groups: o.groups } : {}),
      ...(i === 0 && o.outline !== undefined ? { outline: o.outline } : {}),
      draw: (page, top) => drawLine(ctx, page, line, o.x, baselineIn(top, o.lead, o.size)),
    };
  });
}

// ---- blocks to boxes ----

interface Frame {
  x: number;
  width: number;
  /** Text colour of the frame (quotes are a little lighter). */
  color: RGB;
  groups: readonly Group[];
  listDepth: number;
}

function blockBoxes(ctx: Context, blocks: readonly Block[], frame: Frame, first: boolean): Box[] {
  const out: Box[] = [];
  blocks.forEach((b, i) => {
    const isFirst = first && i === 0;
    out.push(...oneBlock(ctx, b, frame, isFirst));
  });
  return out;
}

function oneBlock(ctx: Context, b: Block, f: Frame, first: boolean): Box[] {
  const base = (face: FaceName, size: number, color = f.color): TextStyle => ({ face, size, color });
  switch (b.kind) {
    case 'heading': {
      const h = HEADINGS[b.level];
      const lines = breakLines(ctx.m.runs(b.runs, base('bold', h.size, INK)), f.width);
      const boxes = textBoxes(ctx, lines, { x: f.x, lead: h.lead, size: h.size, before: first ? 0 : h.before, keepAll: true, groups: f.groups, ...(b.level <= 3 ? { outline: textOfRuns(b.runs) } : {}) });
      // the space after a heading is part of it, so it stays on the heading's page
      const last = boxes[boxes.length - 1];
      if (last !== undefined) last.height += h.after;
      return boxes;
    }
    case 'paragraph': {
      const lines = breakLines(ctx.m.runs(b.runs, base('regular', BODY.size)), f.width);
      return textBoxes(ctx, lines, { x: f.x, lead: BODY.lead, size: BODY.size, before: first ? 0 : BODY.after, groups: f.groups });
    }
    case 'list': {
      const out: Box[] = [];
      const indent = INDENT;
      b.items.forEach((item, k) => {
        const marker = b.ordered ? `${b.start + k}.` : f.listDepth % 2 === 0 ? '•' : '–';
        const inner: Frame = { ...f, x: f.x + indent, width: f.width - indent, listDepth: f.listDepth + 1 };
        const boxes = blockBoxes(ctx, item.blocks, inner, true);
        const head = boxes[0];
        if (head !== undefined) {
          const draw = head.draw.bind(head);
          const markerWidth = ctx.m.width('regular', marker, BODY.size);
          head.draw = (page, top, height) => {
            draw(page, top, height);
            const baseline = baselineIn(top, BODY.lead, BODY.size);
            page.drawText(marker, { x: f.x + indent - 6 - markerWidth, y: baseline, size: BODY.size, font: ctx.faces.regular.pdf, color: f.color });
          };
          // items sit 4 pt apart; a list inside an item sits as close under the item's text
          head.before = k === 0 ? (first ? 0 : f.listDepth > 0 ? 4 : BODY.after) : 4;
        }
        out.push(...boxes);
      });
      return out;
    }
    case 'quote': {
      const group: Group = { kind: 'quote', x: f.x + 1.5, width: 3, id: ++groupIds };
      const inner: Frame = { ...f, x: f.x + INDENT, width: f.width - INDENT, color: INK_2, groups: [...f.groups, group] };
      const boxes = blockBoxes(ctx, b.blocks, inner, true);
      if (boxes[0] !== undefined) boxes[0].before = first ? 0 : BODY.after + 4;
      // a little space after the quote, kept off the next block's page top
      const last = boxes[boxes.length - 1];
      if (last !== undefined) last.height += 2;
      return boxes;
    }
    case 'code':
      return codeBoxes(ctx, b.text, f, first);
    case 'figure':
      return figureBoxes(ctx, b.images, b.caption, f, first);
    case 'table':
      return tableBoxes(ctx, b.rows, f, first);
    case 'rule': {
      const width = 72;
      return [
        {
          height: 20,
          before: first ? 0 : BODY.after,
          draw: (page, top) => page.drawLine({ start: { x: f.x + (f.width - width) / 2, y: top - 10 }, end: { x: f.x + (f.width + width) / 2, y: top - 10 }, thickness: 0.75, color: RULE }),
        },
      ];
    }
  }
}

function codeBoxes(ctx: Context, text: string, f: Frame, first: boolean): Box[] {
  const group: Group = { kind: 'code', x: f.x, width: f.width, id: ++groupIds };
  const groups = [...f.groups, group];
  const inner = f.width - 2 * CODE.padX;
  const charWidth = ctx.m.width('mono', 'M', CODE.size);
  const perLine = Math.max(8, Math.floor(inner / charWidth));
  const rows: string[] = [];
  for (const raw of text.split('\n')) {
    let chars = Array.from(raw.replace(INVISIBLE, ''));
    if (chars.length === 0) rows.push('');
    // A long line wraps after a space when there is one late enough in the line, else after the last character that fits.
    while (chars.length > 0) {
      let cut = Math.min(chars.length, perLine);
      if (cut < chars.length) {
        const space = chars.lastIndexOf(' ', cut - 1);
        if (space > perLine * 0.5) cut = space + 1;
      }
      rows.push(chars.slice(0, cut).join('').replace(/ +$/u, ''));
      chars = chars.slice(cut);
    }
  }
  return rows.map((row, i): Box => {
    const firstRow = i === 0;
    const lastRow = i === rows.length - 1;
    const pieces = ctx.m.runs([{ text: row.replace(/ /gu, '\u00a0') }], { face: 'mono', size: CODE.size, color: INK });
    const line: Line = { pieces, width: pieces.reduce((w, p) => w + p.width + p.space, 0) };
    return {
      height: CODE.lead + (firstRow ? CODE.padY : 0) + (lastRow ? CODE.padY : 0),
      before: firstRow ? (first ? 0 : BODY.after + 2) : 0,
      groups,
      ...(rows.length >= 2 && (firstRow || i === rows.length - 2) ? { keep: true } : {}),
      draw: (page, top) => {
        drawLine(ctx, page, line, f.x + CODE.padX, baselineIn(top - (firstRow ? CODE.padY : 0), CODE.lead, CODE.size));
      },
    };
  });
}

/** A picture's size on the page: its size on the web page (at 96 px to the inch), up to the width there is. */
function pictureSize(ref: ImageRef, r: { width: number; height: number }, f: Frame, maxHeight: number): { width: number; height: number } {
  const room = f.groups.length === 0 && f.listDepth === 0 ? WIDE : f.width;
  const shown = (ref.width > 0 ? ref.width : r.width) * 0.75;
  let width = shown >= f.width * 0.66 ? Math.min(room, Math.max(f.width, shown)) : Math.min(shown, f.width);
  // never more than twice its own pixels (it would look soft)
  width = Math.min(width, Math.max(r.width * 0.75 * 2, 24));
  let height = (width * r.height) / r.width;
  if (height > maxHeight) {
    width = (width * maxHeight) / height;
    height = maxHeight;
  }
  return { width, height };
}

function figureBoxes(ctx: Context, images: readonly ImageRef[], caption: readonly Inline[], f: Frame, first: boolean): Box[] {
  const out: Box[] = [];
  const bodyHeight = ctx.pageHeight - TOP - BOTTOM;
  images.forEach((ref, k) => {
    const picture = ctx.pictures.get(ref);
    const before = k === 0 ? (first ? 0 : BODY.after + 6) : 8;
    if (picture === undefined) {
      // The picture could not be read from the page: a quiet card in its place says so.
      const label = ref.alt !== '' ? `Picture not copied from the page: “${ref.alt.slice(0, 120)}”` : 'Picture not copied from the page';
      const lines = breakLines(ctx.m.runs([{ text: label }], { face: 'regular', size: SMALL.size, color: INK_2 }), f.width - 32);
      const height = Math.max(44, lines.length * SMALL.lead + 22);
      out.push({
        height,
        before,
        keep: caption.length > 0 && k === images.length - 1,
        groups: f.groups,
        draw: (page, top) => {
          roundedRect(page, f.x, top - height, f.width, height, 8, SURFACE);
          const textTop = top - (height - lines.length * SMALL.lead) / 2;
          lines.forEach((line, i) => drawLine(ctx, page, line, f.x + (f.width - line.width) / 2, baselineIn(textTop - i * SMALL.lead, SMALL.lead, SMALL.size)));
        },
      });
      return;
    }
    const size = pictureSize(ref, picture, f, bodyHeight * 0.72);
    out.push({
      height: size.height,
      // A tall picture may shrink to 60% to fit the rest of a page (never below 140 pt).
      ...(size.height > 140 ? { minHeight: Math.max(140, size.height * 0.6) } : {}),
      before,
      keep: caption.length > 0 && k === images.length - 1,
      groups: f.groups,
      draw: (page, top, height) => {
        const width = (size.width * height) / size.height;
        const x = width > f.width ? (ctx.pageWidth - width) / 2 : f.x + (f.width - width) / 2;
        page.drawImage(picture.image, { x, y: top - height, width, height });
      },
    });
  });
  if (caption.length > 0) {
    const lines = breakLines(ctx.m.runs(caption, { face: 'regular', size: SMALL.size, color: INK_3 }), f.width);
    out.push(...textBoxes(ctx, lines, { x: f.x, lead: SMALL.lead, size: SMALL.size, before: 6, groups: f.groups }));
  }
  // a little more room after a figure than after a paragraph
  const last = out[out.length - 1];
  if (last !== undefined) last.height += 4;
  return out;
}

function tableBoxes(ctx: Context, rows: readonly { header: boolean; cells: Inline[][] }[], f: Frame, first: boolean): Box[] {
  const columns = Math.max(...rows.map((r) => r.cells.length));
  const style = (header: boolean): TextStyle => ({ face: header ? 'bold' : 'regular', size: TABLE.size, color: INK });
  // Each column gets room by how much text it holds (its widest cell on one line, softened), at least 48 pt.
  const natural = Array.from({ length: columns }, (_, c) =>
    Math.max(24, ...rows.map((r) => ctx.m.runs(r.cells[c] ?? [], style(r.header)).reduce((w, p) => w + p.width + p.space, 0) + 2 * TABLE.pad)),
  );
  const total = natural.reduce((a, b) => a + b, 0);
  let widths: number[];
  if (total <= f.width) widths = natural.map((w) => w + (f.width - total) / columns);
  else {
    const soft = natural.map((w) => Math.sqrt(w));
    const sum = soft.reduce((a, b) => a + b, 0);
    widths = soft.map((w) => Math.max(48, (w / sum) * f.width));
    const over = widths.reduce((a, b) => a + b, 0) / f.width;
    widths = widths.map((w) => w / over);
  }
  const headerRows = rows.filter((r) => r.header).length;
  const boxes = rows.map((row, ri): Box => {
    const cells = widths.map((w, c) => breakLines(ctx.m.runs(row.cells[c] ?? [], style(row.header)), w - 2 * TABLE.pad));
    const height = Math.max(1, ...cells.map((l) => l.length)) * TABLE.lead + 2 * TABLE.pad;
    const lastHeader = row.header && ri === headerRows - 1;
    return {
      height,
      before: ri === 0 ? (first ? 0 : BODY.after + 4) : 0,
      ...(row.header || ri === 0 ? { keep: true } : {}),
      groups: f.groups,
      draw: (page, top) => {
        let x = f.x;
        cells.forEach((lines, c) => {
          lines.forEach((line, li) => drawLine(ctx, page, line, x + TABLE.pad, baselineIn(top - TABLE.pad - li * TABLE.lead, TABLE.lead, TABLE.size)));
          x += widths[c];
        });
        const y = top - height;
        page.drawLine({ start: { x: f.x, y }, end: { x: f.x + f.width, y }, thickness: lastHeader ? 1 : 0.5, color: lastHeader ? RULE : RULE_LIGHT });
        // the top rule of the table, and of its header again on a new page
        if (ri === 0 || row.header) page.drawLine({ start: { x: f.x, y: top }, end: { x: f.x + f.width, y: top }, thickness: 1, color: RULE });
      },
    };
  });
  // One header row is drawn again at the top of each new page the table runs onto.
  const header = headerRows === 1 ? boxes[0] : undefined;
  if (header !== undefined) for (const b of boxes.slice(1)) b.header = header;
  return boxes;
}

function roundedRect(page: PDFPage, x: number, y: number, w: number, h: number, r: number, color: RGB): void {
  const k = r * 0.5523;
  // drawSvgPath measures y downwards from the point it is given.
  const path = `M ${r} 0 H ${w - r} C ${w - r + k} 0 ${w} ${r - k} ${w} ${r} V ${h - r} C ${w} ${h - r + k} ${w - r + k} ${h} ${w - r} ${h} H ${r} C ${r - k} ${h} 0 ${h - r + k} 0 ${h - r} V ${r} C 0 ${r - k} ${r - k} 0 ${r} 0 Z`;
  page.drawSvgPath(path, { x, y: y + h, color, borderWidth: 0 });
}

// ---- page 1: title, byline, the source card ----

function headerBoxes(ctx: Context, a: Article, savedAt: number, locale: string | undefined, missing: number): Box[] {
  const f = { x: ctx.left, width: MEASURE };
  const out: Box[] = [];
  const dateFormat = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' });
  if (a.siteName !== null) {
    const lines = breakLines(ctx.m.runs([{ text: a.siteName }], { face: 'bold', size: 9.5, color: LINK }), f.width);
    out.push(...textBoxes(ctx, lines, { x: f.x, lead: 14, size: 9.5, before: 0, keepAll: true }));
    const last = out[out.length - 1];
    if (last !== undefined) last.height += 6;
  }
  const titleLines = breakLines(ctx.m.runs([{ text: a.title }], { face: 'bold', size: 24, color: INK }), f.width);
  out.push(...textBoxes(ctx, titleLines, { x: f.x, lead: 30, size: 24, before: 0, keepAll: true, outline: a.title }));
  const published = publishedDate(a.published, dateFormat);
  const by = a.authors.length > 0 ? `By ${joinNames(a.authors)}` : a.byline;
  const sub = [by, published].filter((s): s is string => s !== null && s !== '').join('  ·  ');
  if (sub !== '') {
    const lines = breakLines(ctx.m.runs([{ text: sub }], { face: 'regular', size: 11, color: INK_2 }), f.width);
    out.push(...textBoxes(ctx, lines, { x: f.x, lead: 16, size: 11, before: 10, keepAll: true }));
  }
  // The source card: where the page came from (a link), when it was saved, and any picture that could not be copied.
  const linkText = shortLink(a.url);
  const cardLines: Line[] = [];
  const pad = 12;
  const inner = f.width - 2 * pad;
  cardLines.push(...breakLines(ctx.m.runs([{ text: 'From ' }, { text: linkText, href: a.url }], { face: 'regular', size: SMALL.size, color: INK_2 }), inner));
  cardLines.push(...breakLines(ctx.m.runs([{ text: `Saved on ${dateFormat.format(savedAt)}` }], { face: 'regular', size: SMALL.size, color: INK_2 }), inner));
  if (missing > 0) {
    const words = missing === 1 ? '1 picture couldn’t be copied from the page.' : `${missing} pictures couldn’t be copied from the page.`;
    cardLines.push(...breakLines(ctx.m.runs([{ text: words }], { face: 'regular', size: SMALL.size, color: INK_2 }), inner));
  }
  const cardHeight = cardLines.length * SMALL.lead + 2 * 9;
  out.push({
    height: cardHeight,
    before: 16,
    draw: (page, top) => {
      roundedRect(page, f.x, top - cardHeight, f.width, cardHeight, 8, SURFACE);
      cardLines.forEach((line, i) => drawLine(ctx, page, line, f.x + pad, baselineIn(top - 9 - i * SMALL.lead, SMALL.lead, SMALL.size)));
    },
  });
  const last = out[out.length - 1];
  if (last !== undefined) last.height += 22;
  return out;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function publishedDate(published: string | null, format: Intl.DateTimeFormat): string | null {
  if (published === null) return null;
  const t = Date.parse(published);
  if (Number.isFinite(t)) return format.format(t);
  return published.length <= 40 ? published : null;
}

/** "medium.com/@ada/how-to-read" without the scheme; the middle is cut when it is very long. */
function shortLink(url: string): string {
  let text = url;
  try {
    const u = new URL(url);
    // The query is left out of what is shown (it is mostly tracking); the link itself keeps it.
    text = `${u.host.replace(/^www\./u, '')}${u.pathname === '/' ? '' : decodeURI(u.pathname).replace(/\/$/u, '')}`;
  } catch {
    // shown as it is
  }
  return text.length > 90 ? `${text.slice(0, 60)}…${text.slice(-26)}` : text;
}

// ---- pages ----

/** Places the boxes page after page, keeping together what must stay together. */
function paginate(ctx: Context, boxes: readonly Box[], pageSize: readonly [number, number]): { pages: PDFPage[]; outline: { title: string; page: PDFPage; top: number }[] } {
  const [w, h] = pageSize;
  const pages: PDFPage[] = [];
  const outline: { title: string; page: PDFPage; top: number }[] = [];
  let page: PDFPage | null = null;
  let y = 0;
  let placed: { box: Box; top: number; height: number }[] = [];
  const finish = () => {
    if (page === null) return;
    drawGroups(page, placed);
    for (const p of placed) p.box.draw(page, p.top, p.height);
    placed = [];
  };
  const newPage = () => {
    finish();
    page = ctx.doc.addPage([w, h]);
    pages.push(page);
    y = h - TOP;
  };
  const place = (box: Box, height: number) => {
    const top = y - (placed.length === 0 ? 0 : box.before);
    placed.push({ box, top, height });
    if (box.outline !== undefined && page !== null) outline.push({ title: box.outline, page, top });
    y = top - height;
  };
  newPage();
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const atTop = placed.length === 0;
    // This box and the ones it must stay with (at most 8 ahead) must fit, or a new page starts.
    let rest = 0;
    for (let j = i; j < Math.min(boxes.length - 1, i + 8) && boxes[j].keep; j++) rest += boxes[j + 1].before + boxes[j + 1].height;
    const room = y - BOTTOM - (atTop ? 0 : box.before) - rest;
    let height = box.height;
    if (!atTop && room < box.height) {
      if (box.minHeight !== undefined && room >= box.minHeight) height = room;
      else newPage();
    }
    if (placed.length === 0 && box.header !== undefined && box.header !== box) place(box.header, box.header.height);
    place(box, height);
  }
  finish();
  return { pages, outline };
}

/** The code backgrounds and quote bars of one page, drawn under the text. */
function drawGroups(page: PDFPage, placed: readonly { box: Box; top: number; height: number }[]): void {
  const spans = new Map<number, { g: Group; top: number; bottom: number }>();
  for (const { box, top, height } of placed) {
    for (const g of box.groups ?? []) {
      const s = spans.get(g.id);
      if (s === undefined) spans.set(g.id, { g, top, bottom: top - height });
      else s.bottom = top - height;
    }
  }
  for (const { g, top, bottom } of spans.values()) {
    if (g.kind === 'code') roundedRect(page, g.x, bottom, g.width, top - bottom, 6, CODE_BG);
    else page.drawRectangle({ x: g.x - g.width / 2, y: bottom + 2, width: g.width, height: Math.max(0, top - bottom - 4), color: RULE });
  }
}

/**
 * "2 of 7" at the foot of each page. Only the number: the title or the site on every page would make every page a search hit
 * for them.
 */
function drawFooters(ctx: Context, pages: readonly PDFPage[]): void {
  const size = 8;
  pages.forEach((page, i) => {
    const label = `${i + 1} of ${pages.length}`;
    const width = ctx.faces.regular.pdf.widthOfTextAtSize(label, size);
    page.drawText(label, { x: ctx.left + MEASURE - width, y: 40, size, font: ctx.faces.regular.pdf, color: INK_3 });
  });
}

function addLinks(ctx: Context): void {
  for (const l of ctx.links) {
    const annot = ctx.doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: l.rect,
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(l.href) },
    });
    l.page.node.addAnnot(ctx.doc.context.register(annot));
  }
}

/** The headings as the PDF's outline (bookmarks), one flat list in reading order. */
function addOutline(ctx: Context, items: readonly { title: string; page: PDFPage; top: number }[]): void {
  if (items.length < 2) return;
  const context = ctx.doc.context;
  const root = context.nextRef();
  const refs = items.map(() => context.nextRef());
  items.forEach((item, i) => {
    const dict = context.obj({});
    dict.set(PDFName.of('Title'), PDFString.of(item.title.slice(0, 200)));
    dict.set(PDFName.of('Parent'), root);
    if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
    if (i < refs.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
    const dest = PDFArray.withContext(context);
    dest.push(item.page.ref);
    dest.push(PDFName.of('XYZ'));
    dest.push(PDFNumber.of(0));
    dest.push(PDFNumber.of(Math.round(item.top + 12)));
    dest.push(context.obj(null));
    dict.set(PDFName.of('Dest'), dest);
    context.assign(refs[i], dict);
  });
  const outlines = context.obj({ Type: 'Outlines', Count: items.length });
  outlines.set(PDFName.of('First'), refs[0]);
  outlines.set(PDFName.of('Last'), refs[refs.length - 1]);
  context.assign(root, outlines);
  ctx.doc.catalog.set(PDFName.of('Outlines'), root);
}

// ---- the whole thing ----

export async function typesetArticle(input: TypesetInput): Promise<TypesetResult> {
  const { article } = input;
  const paper = PAPER[paperFor(input.locale)];
  const doc = await PDFDocument.create({ updateMetadata: false });
  const faces = await embedFaces(doc, input.fonts);

  // Characters no font has: drawn as small pictures (or left out where that cannot be done).
  const lacking = new Set<string>();
  let lackingCount = 0;
  const probe = new Measurer(faces, new Map());
  const scan = (text: string, face: FaceName) => {
    for (const { segment } of graphemes.segment(text.replace(INVISIBLE, ''))) {
      if (/\s/u.test(segment) || probe.faceFor(face, segment) !== null) continue;
      lacking.add(segment);
      lackingCount += 1;
    }
  };
  scan(article.title, 'bold');
  scan(article.siteName ?? '', 'bold');
  scan(article.byline ?? '', 'regular');
  for (const t of runTexts(article.blocks)) scan(t.text, t.face);
  if (lackingCount > MAX_PICTURE_CHARS) throw new UnsupportedScriptError();
  const pictures = lacking.size > 0 && input.glyphPictures !== undefined ? await input.glyphPictures([...lacking]).catch(() => new Map<string, GlyphPicture>()) : new Map<string, GlyphPicture>();

  // The pictures that were read, each embedded once. One pdf-lib cannot read counts as not copied.
  const embeddedPictures = new Map<ImageRef, { image: PDFImage; width: number; height: number }>();
  for (const [ref, r] of input.images) {
    if (!r.ok) continue;
    try {
      const bytes = dataUrlBytes(r.dataUrl);
      const image = r.dataUrl.startsWith('data:image/png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      embeddedPictures.set(ref, { image, width: r.width, height: r.height });
    } catch {
      // left out: the PDF shows "Picture not copied from the page" in its place
    }
  }
  const missing = [...imageRefs(article.blocks)].filter((ref) => !embeddedPictures.has(ref)).length;
  const glyphs = new Map<string, PDFImage>();
  for (const [key, p] of pictures) {
    try {
      glyphs.set(key, await doc.embedPng(p.png));
    } catch {
      // that character is left out
    }
  }

  const left = (paper[0] - MEASURE) / 2;
  const ctx: Context = { doc, faces, m: new Measurer(faces, pictures), pageWidth: paper[0], pageHeight: paper[1], left, pictures: embeddedPictures, glyphs, links: [] };
  const boxes = [...headerBoxes(ctx, article, input.savedAt, input.locale, missing), ...blockBoxes(ctx, article.blocks, { x: left, width: MEASURE, color: INK, groups: [], listDepth: 0 }, true)];
  const { pages, outline } = paginate(ctx, boxes, paper);
  drawFooters(ctx, pages);
  addLinks(ctx);
  addOutline(ctx, outline);

  doc.setTitle(article.title, { showInWindowTitleBar: true });
  if (article.authors.length > 0) doc.setAuthor(article.authors.join(', '));
  doc.setSubject(article.url);
  doc.setCreator('sickofpdfs: Save this page to library');
  doc.setProducer('sickofpdfs');
  doc.setCreationDate(new Date(input.savedAt));
  doc.setModificationDate(new Date(input.savedAt));
  doc.setLanguage(article.lang ?? 'en');
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, pageCount: pages.length, missingPictures: missing };
}

function dataUrlBytes(url: string): Uint8Array {
  const comma = url.indexOf(',');
  const bin = atob(url.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function* runTexts(blocks: readonly Block[]): Generator<{ text: string; face: FaceName }> {
  for (const b of blocks) {
    if (b.kind === 'heading' || b.kind === 'paragraph') yield { text: textOfRuns(b.runs), face: 'regular' };
    else if (b.kind === 'code') yield { text: b.text, face: 'mono' };
    else if (b.kind === 'figure') yield { text: textOfRuns(b.caption), face: 'regular' };
    else if (b.kind === 'list') for (const i of b.items) yield* runTexts(i.blocks);
    else if (b.kind === 'quote') yield* runTexts(b.blocks);
    else if (b.kind === 'table') for (const r of b.rows) for (const c of r.cells) yield { text: textOfRuns(c), face: 'regular' };
  }
}

function* imageRefs(blocks: readonly Block[]): Generator<ImageRef> {
  for (const b of blocks) {
    if (b.kind === 'figure') yield* b.images;
    else if (b.kind === 'list') for (const i of b.items) yield* imageRefs(i.blocks);
    else if (b.kind === 'quote') yield* imageRefs(b.blocks);
  }
}
