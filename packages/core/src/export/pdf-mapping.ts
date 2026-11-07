// How every note becomes a PDF annotation (contracts §9), as a plan: pure, no engine, no clock, no randomness.
// Slice 8.2 writes the plan into a copy of the file; slice 8.3 gathers the rows and calls this.
//
// The table (contracts §9):
//   highlight / underline / strikethrough  → /Highlight / /Underline / /StrikeOut, /QuadPoints from the anchor's line rects
//   bold                                   → /Square, no border, /Subj (Bold), appearance = the glyphs in synthetic bold
//                                            (R90b, as the screen draws them); one per page
//   area mark                              → /Square, outline in the area colour, no fill
//   text thread                            → root = the /Highlight over the same range if there is one (and it has no thread
//                                            yet), else an /Underline with a dotted appearance; /Contents = the root comment
//                                            as plain text; plus a closed /Popup
//   area or figure thread                  → /Square on the rect as root, plus a /Popup
//   pin, point or page note                → /Text (note icon) at the point, or in the page's top-left margin
//   document note                          → /Text on page 1, /Subj (Document note)
//   replies                                → 'threaded': one /Text each, /IRT = the root, /RT /R; 'folded': appended to the
//                                            root's /Contents ("Name: text", one blank line apart)
//   a thread that cannot be placed         → a /Text note on its stored page that starts with the quote, so nothing is dropped
//
// COORDINATES. Everything in a PdfAnnotationPlan is in PDF user space, the space /Rect and /QuadPoints are written in:
// origin at the page's bottom-left, y up, unrotated (the page's /Rotate is not applied). A `PdfUserRect` there is
// { x, y } = the LOWER-LEFT corner, plus width and height. Normalised rects (0–1 of the crop box, origin top-left) convert
// with the crop box's offset: left = crop.left + x0 × width, top = crop.top − y0 × height. Each quad of a text mark is the
// axis-aligned rectangle of one line of text; `quadPoints` turns it into the eight numbers in Acrobat's order for the
// page's /Rotate (spike report 8.0, "QUADS").
//
// COLOURS are 0–255 integers. The five fills come in `markRgb`; underlines, strikethroughs, area outlines and the dotted
// thread underline have their own tokens (--sop-mark-N-line, --sop-area-outline, --sop-thread-underline), passed as
// the optional `lineRgb`, `areaRgb` and `threadRgb`. Left out, they fall back to the fills.
import type { Rotation } from '../../../viewer/src/backend/types';
import type { Author, MarkId, ThreadId } from '../ids';
import type { Anchor, CharPos, NormRect } from '../model/anchor';
import type { CommentRow, MarkColor, MarkRow, ThreadRow } from '../model/rows';
import { CLAUDE_LABEL, SUBJ_BOLD, SUBJ_DOCUMENT_NOTE, SUBJ_PAGE_NOTE, SUBJ_THREAD, partNm, popupNm, rowNm } from './nm';
import { commentPlainText } from './note-text';

export type { Rotation };

/**
 * A rectangle in PDF USER SPACE: origin at the page's lower left, y up, before /Rotate, as written in /Rect and
 * /QuadPoints. `{ x, y }` is the LOWER-LEFT corner. It is not the engine's `PdfRect` (backend/types.ts: unrotated page
 * space, origin at the crop box's top-left, y down), and the two must never be mixed. The shapes are the same, so the
 * compiler cannot tell them apart: nothing here converts between them, and the only ways in and out are `normToUser` and
 * `userToNorm` (stored 0–1 geometry), which take the page's `PageGeometry`.
 */
export interface PdfUserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Contracts §9: a page's boxes in PDF user space (origin bottom-left) and its /Rotate. Slice 8.2 declares the same shape in backend/types.ts. */
export interface PageGeometry {
  /** [left, bottom, right, top] */
  crop: [number, number, number, number];
  media: [number, number, number, number];
  rotation: Rotation;
}

/** What `place` answers: where an anchor is on these bytes, as normalised line rects per page. */
export type NormRectsByPage = { page: number; rects: NormRect[] }[];

export type Rgb = [number, number, number];

/** /F bits (ISO 32000-1 Table 165: bit n is the value 2^(n−1)). */
export const ANNOT_FLAG = { hidden: 2, print: 4, noZoom: 8, noRotate: 16 } as const;
const NOTE_FLAGS = ANNOT_FLAG.print | ANNOT_FLAG.noZoom | ANNOT_FLAG.noRotate;

/** A note icon's side, a reply's invisible box, the margin the page notes sit in, and the gap between stacked page notes (points). */
export const NOTE_ICON_SIZE = 20;
const REPLY_BOX = 16;
const NOTE_MARGIN = 18;
const NOTE_STACK_GAP = 4;
/** A pop-up window's size (points). */
const POPUP_W = 220;
const POPUP_H = 120;
/** A char range that runs to the end of its page (the engine clamps it). */
const TO_PAGE_END = 2 ** 30;

export type PdfSubtype = 'Highlight' | 'Underline' | 'StrikeOut' | 'Square' | 'Text' | 'Popup';

/**
 * Contracts §9, with these readings:
 * - `rect` and `quads`: PDF user space, see above. `quads` is empty except for the three text markups.
 * - `ap.kind`: how slice 8.2 draws the annotation. 'text-markup' PDFium's own highlight (drawn with a Multiply blend),
 *   underline or strikethrough; 'dotted-underline' a dotted line along each quad's baseline in `rgb`; 'bold-outlines' the
 *   glyphs of the chars `ap.chars` in the screen's synthetic bold (R90b: each outline emboldened by its face's own gain,
 *   filled in the text's own colour; the exporter reads them with getGlyphShapes, marks/bold-vector.ts); 'box' the outline of `rect` in `rgb`, no fill; 'note-icon' the note icon;
 *   'empty' an appearance that draws nothing. A /Popup has no appearance at all (ISO 32000-1 12.5.6.14): its kind is
 *   'empty' and the writer writes none.
 * - `irt`: the NM of the root a reply answers; `popupOf`: the NM of the annotation a /Popup belongs to. The writer creates
 *   annotations in array order, and a root and its popup always come before their replies.
 * - `createdAt` and `modifiedAt` are Unix ms; the writer formats them as PDF dates.
 */
export interface PdfAnnotationPlan {
  nm: string;
  subtype: PdfSubtype;
  pageIndex: number;
  rect: PdfUserRect;
  quads: PdfUserRect[];
  rgb: Rgb | null;
  contents: string | null;
  author: string | null;
  subject: string | null;
  createdAt: number;
  modifiedAt: number;
  irt: string | null;
  popupOf: string | null;
  flags: number;
  ap: { kind: 'text-markup' | 'dotted-underline' | 'bold-outlines' | 'box' | 'note-icon' | 'empty'; chars?: { start: number; count: number } };
}

export interface PdfExportInput {
  marks: readonly MarkRow[];
  threads: readonly ThreadRow[];
  comments: readonly CommentRow[];
  /** Indexed by pageIndex. */
  geometry: readonly PageGeometry[];
  /** Where an anchor is on these bytes, or null when it cannot be placed. */
  place(a: Anchor): NormRectsByPage | null;
}

export interface PdfExportOptions {
  /** 'threaded': one /Text reply per comment. 'folded': replies go into the root's /Contents. */
  replies: 'threaded' | 'folded';
  markRgb: Record<MarkColor, Rgb>;
  /** /T of the owner's notes; blank gives no /T. Claude's are "Claude". */
  ownerName: string;
  /** Underline and strikethrough colours (--sop-mark-N-line). Default: `markRgb`. */
  lineRgb?: Record<MarkColor, Rgb>;
  /** Area and figure outlines (--sop-area-outline). Default: `markRgb[1]`. */
  areaRgb?: Rgb;
  /** The dotted underline of a thread with no highlight (--sop-thread-underline). Default: `areaRgb`, then `markRgb[1]`. */
  threadRgb?: Rgb;
  /**
   * How a threaded reply is drawn. 'empty' (default, decision D8.1, sample A): not hidden, an empty appearance.
   * 'hidden': /F is Hidden and the appearance is empty (sample B). The Foxit and Acrobat hand check W-F1 decides which
   * one the product keeps.
   */
  replyAppearance?: 'hidden' | 'empty';
}

export interface PdfExportPlan {
  annotations: PdfAnnotationPlan[];
  /** Threads that became a note in the margin because their anchor could not be placed. */
  notPlaced: ThreadId[];
  /** Marks left out because their anchor could not be placed (a mark has no note to fall back to). */
  skippedMarks: MarkId[];
}

// ---- geometry ----

const sizeOf = (g: PageGeometry) => ({ w: g.crop[2] - g.crop[0], h: g.crop[3] - g.crop[1] });

/** A normalised rect (0–1 of the crop box, origin top-left) in user space. */
export function normToUser(g: PageGeometry, n: NormRect): PdfUserRect {
  const { w, h } = sizeOf(g);
  const x0 = Math.min(n[0], n[2]), x1 = Math.max(n[0], n[2]);
  const y0 = Math.min(n[1], n[3]), y1 = Math.max(n[1], n[3]);
  return { x: g.crop[0] + x0 * w, y: g.crop[3] - y1 * h, width: (x1 - x0) * w, height: (y1 - y0) * h };
}

/** A user-space rect as normalised 0–1 of the crop box, origin top-left (the reverse of normToUser). */
export function userToNorm(g: PageGeometry, r: PdfUserRect): NormRect {
  const { w, h } = sizeOf(g);
  const x0 = (r.x - g.crop[0]) / w, x1 = (r.x + r.width - g.crop[0]) / w;
  const y0 = (g.crop[3] - (r.y + r.height)) / h, y1 = (g.crop[3] - r.y) / h;
  return [x0, y0, x1, y1];
}

/** A normalised point [x, y] in user space. */
export function pointToUser(g: PageGeometry, p: readonly [number, number]): { x: number; y: number } {
  const { w, h } = sizeOf(g);
  return { x: g.crop[0] + p[0] * w, y: g.crop[3] - p[1] * h };
}

/** A user-space point as a normalised [x, y]. */
export function userToPoint(g: PageGeometry, p: { x: number; y: number }): [number, number] {
  const { w, h } = sizeOf(g);
  return [(p.x - g.crop[0]) / w, (g.crop[3] - p.y) / h];
}

/**
 * The eight /QuadPoints numbers of one line rect, in the order Acrobat writes and reads: top-left, top-right,
 * bottom-left, bottom-right (not the counterclockwise order the standard's text says). "Top" is as the page is displayed,
 * so a page with /Rotate 90 starts at the corner that is the displayed top-left.
 */
export function quadPoints(r: PdfUserRect, rotation: Rotation): number[] {
  const l = r.x, b = r.y, rr = r.x + r.width, t = r.y + r.height;
  switch (rotation) {
    case 90: return [l, b, l, t, rr, b, rr, t];
    case 180: return [rr, b, l, b, rr, t, l, t];
    case 270: return [rr, t, rr, b, l, t, l, b];
    default: return [l, t, rr, t, l, b, rr, b];
  }
}

/** A point given 0–1 of `outer` (a figure's box), as 0–1 of the page. */
const withinRect = (outer: NormRect, p: readonly [number, number]): [number, number] => [outer[0] + p[0] * (outer[2] - outer[0]), outer[1] + p[1] * (outer[3] - outer[1])];
/** A rect given 0–1 of `outer` (a figure's box), as 0–1 of the page. */
const rectWithin = (outer: NormRect, r: NormRect): NormRect => [...withinRect(outer, [r[0], r[1]]), ...withinRect(outer, [r[2], r[3]])];

/** The smallest rect holding all of `rs`. */
export function unionRect(rs: readonly PdfUserRect[]): PdfUserRect {
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.width)), y1 = Math.max(...rs.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const clampRectInto = (g: PageGeometry, r: PdfUserRect): PdfUserRect => ({
  x: Math.min(Math.max(g.crop[0], r.x), Math.max(g.crop[0], g.crop[2] - r.width)),
  y: Math.min(Math.max(g.crop[1], r.y), Math.max(g.crop[1], g.crop[3] - r.height)),
  width: r.width,
  height: r.height,
});

/** A closed pop-up window to the right of its parent, kept on the page. */
function popupRect(g: PageGeometry, parent: PdfUserRect): PdfUserRect {
  const top = Math.min(g.crop[3], Math.max(g.crop[1] + POPUP_H, parent.y + parent.height));
  const left = Math.min(Math.max(g.crop[0], parent.x + parent.width + 8), Math.max(g.crop[0], g.crop[2] - POPUP_W));
  return { x: left, y: top - POPUP_H, width: POPUP_W, height: POPUP_H };
}

// ---- rows ----

const cmpPos = (a: CharPos, b: CharPos): number => (a.page !== b.page ? a.page - b.page : a.index - b.index);
type ByReading = { pageIndex: number | null; sortKey: number | null; createdAt: number; id: string };
const byReading = (a: ByReading, b: ByReading): number =>
  (a.pageIndex ?? -1) - (b.pageIndex ?? -1) || (a.sortKey ?? -1) - (b.sortKey ?? -1) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A comment that is finished: Claude's replies that are still being written, or ended in an error, are not final. */
function isFinal(c: CommentRow): boolean {
  if (c.deletedAt !== null || c.draftOfTab !== null) return false;
  const meta = c.meta as { kind?: string; status?: string };
  return !(meta.kind === 'claude-reply' && meta.status !== undefined && meta.status !== 'done');
}

interface Entry {
  pageIndex: number;
  sortKey: number;
  createdAt: number;
  seq: number;
  items: PdfAnnotationPlan[];
}

interface MarkPart {
  pageIndex: number;
  plan: PdfAnnotationPlan;
  entry: Entry;
}

export function planPdfExport(i: PdfExportInput, o: PdfExportOptions): PdfExportPlan {
  const lineRgb = o.lineRgb ?? o.markRgb;
  const areaRgb = o.areaRgb ?? o.markRgb[1];
  const threadRgb = o.threadRgb ?? areaRgb;
  const noteRgb = o.markRgb[1];
  const replyFlags = (o.replyAppearance ?? 'empty') === 'hidden' ? ANNOT_FLAG.hidden : NOTE_FLAGS;
  const authorName = (a: Author): string | null => (a === 'claude' ? CLAUDE_LABEL : o.ownerName.trim() || null);

  const entries: Entry[] = [];
  const skippedMarks: MarkId[] = [];
  const notPlaced: ThreadId[] = [];
  let seq = 0;
  const addEntry = (pageIndex: number, sortKey: number | null, createdAt: number, items: PdfAnnotationPlan[]): Entry => {
    const e: Entry = { pageIndex, sortKey: sortKey ?? 0, createdAt, seq: seq++, items };
    entries.push(e);
    return e;
  };
  const geo = (p: number): PageGeometry | undefined => i.geometry[p];

  /** The placed parts of an anchor that can be drawn: pages with rects and a known geometry, in page order. */
  const partsOf = (a: Anchor): { page: number; g: PageGeometry; rects: PdfUserRect[] }[] | null => {
    const placed = i.place(a);
    if (!placed) return null;
    const parts: { page: number; g: PageGeometry; rects: PdfUserRect[] }[] = [];
    for (const p of [...placed].sort((x, y) => x.page - y.page)) {
      const g = geo(p.page);
      if (!g || p.rects.length === 0) continue;
      const existing = parts.find((q) => q.page === p.page);
      const rects = p.rects.map((n) => normToUser(g, n));
      if (existing) existing.rects.push(...rects);
      else parts.push({ page: p.page, g, rects });
    }
    return parts.length > 0 ? parts : null;
  };

  // ---- 1. marks ----
  const liveMarks = i.marks.filter((m) => m.deletedAt === null).sort(byReading);
  const markParts = new Map<string, MarkPart[]>();
  for (const m of liveMarks) {
    const planned = planMark(m);
    if (!planned) skippedMarks.push(m.id);
    else markParts.set(m.id, planned);
  }

  function planMark(m: MarkRow): MarkPart[] | null {
    const a = m.anchor;
    const common = { quads: [] as PdfUserRect[], contents: null, author: authorName(m.author), subject: null, createdAt: m.createdAt, modifiedAt: m.updatedAt, irt: null, popupOf: null, flags: ANNOT_FLAG.print };
    if (m.style === 'area' || a.kind === 'area' || a.kind === 'figure') {
      if (a.kind !== 'area' && a.kind !== 'figure') return null;
      const parts = partsOf(a);
      const first = parts?.[0];
      if (!first) return null;
      const rect = unionRect(first.rects);
      const rgb = m.color ? o.markRgb[m.color] : areaRgb;
      const plan: PdfAnnotationPlan = { ...common, nm: rowNm(m.id), subtype: 'Square', pageIndex: first.page, rect, rgb, ap: { kind: 'box' } };
      return [{ pageIndex: first.page, plan, entry: addEntry(first.page, m.sortKey, m.createdAt, [plan]) }];
    }
    if (a.kind !== 'text') return null;
    if (m.style === 'bold' && a.textSource !== undefined && a.textSource !== 'pdfium') return null; // bold is not offered on recognised text
    const parts = partsOf(a);
    if (!parts) return null;
    const firstPage = parts[0]?.page ?? 0;
    return parts.map((part) => {
      const quads = part.rects;
      const rect = unionRect(quads);
      const nm = partNm(m.id, part.page, firstPage);
      let plan: PdfAnnotationPlan;
      if (m.style === 'bold') {
        const start = part.page === a.start.page ? a.start.index : 0;
        const end = part.page === a.end.page ? a.end.index : TO_PAGE_END;
        plan = { ...common, nm, subtype: 'Square', pageIndex: part.page, rect, rgb: null, subject: SUBJ_BOLD, ap: { kind: 'bold-outlines', chars: { start, count: Math.max(0, end - start) } } };
      } else {
        const color = m.color ?? 1;
        const subtype = m.style === 'highlight' ? 'Highlight' : m.style === 'underline' ? 'Underline' : 'StrikeOut';
        const rgb = m.style === 'highlight' ? o.markRgb[color] : lineRgb[color];
        plan = { ...common, nm, subtype, pageIndex: part.page, rect, quads, rgb, ap: { kind: 'text-markup' } };
      }
      return { pageIndex: part.page, plan, entry: addEntry(part.page, m.sortKey, m.createdAt, [plan]) };
    });
  }

  // ---- 2. threads ----
  const claimed = new Set<string>();
  const commentsOf = new Map<string, CommentRow[]>();
  for (const c of i.comments) {
    if (!isFinal(c)) continue;
    const list = commentsOf.get(c.threadId);
    if (list) list.push(c);
    else commentsOf.set(c.threadId, [c]);
  }
  for (const list of commentsOf.values()) list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  /** Stacked page notes: the n-th margin note of a page sits n slots below the corner. */
  const marginSlots = new Map<number, number>();
  const marginRect = (pageIndex: number, g: PageGeometry): PdfUserRect => {
    const slot = marginSlots.get(pageIndex) ?? 0;
    marginSlots.set(pageIndex, slot + 1);
    const top = g.crop[3] - NOTE_MARGIN - slot * (NOTE_ICON_SIZE + NOTE_STACK_GAP);
    return clampRectInto(g, { x: g.crop[0] + NOTE_MARGIN, y: top - NOTE_ICON_SIZE, width: NOTE_ICON_SIZE, height: NOTE_ICON_SIZE });
  };

  const liveThreads = i.threads.filter((t) => t.deletedAt === null && t.draftOfTab === null).sort(byReading);
  for (const t of liveThreads) planThread(t);

  function planThread(t: ThreadRow): void {
    const cs = commentsOf.get(t.id);
    const root = cs?.[0];
    if (!cs || !root) return;
    const replies = cs.slice(1);
    const rootText = commentPlainText(root);
    const a = t.anchor;
    const storedPage = t.pageIndex ?? (a.kind === 'text' ? a.start.page : a.kind === 'document' ? 0 : a.page);
    const created = root.createdAt;
    const modified = Math.max(t.updatedAt, root.editedAt ?? root.createdAt);
    const rootAuthor = authorName(root.author);
    const folded = o.replies === 'folded' ? replies.map((r) => `\n\n${authorName(r.author) ?? ''}${authorName(r.author) ? ': ' : ''}${commentPlainText(r)}`).join('') : '';
    const contents = rootText + folded;
    const rootBase = { quads: [] as PdfUserRect[], author: rootAuthor, createdAt: created, modifiedAt: modified, irt: null, popupOf: null };

    let rootPlan: PdfAnnotationPlan | null = null;
    let rootEntry: Entry | null = null;
    let withPopup = false;
    let isNotPlaced = false;

    const note = (pageIndex: number, rect: PdfUserRect, subject: string | null, text: string): void => {
      rootPlan = { ...rootBase, nm: rowNm(t.id), subtype: 'Text', pageIndex, rect, rgb: noteRgb, contents: text, subject, flags: NOTE_FLAGS, ap: { kind: 'note-icon' } };
      rootEntry = addEntry(pageIndex, t.sortKey, t.createdAt, [rootPlan]);
    };

    /** The thread's anchor cannot be placed: a note in the margin of its page that starts with the quote, if it has one. */
    const fallback = (): void => {
      const g = geo(storedPage) ?? geo(0);
      if (!g) return;
      const page = geo(storedPage) ? storedPage : 0;
      const quote = a.kind === 'text' ? a.quote.quote.trim() : '';
      note(page, marginRect(page, g), SUBJ_PAGE_NOTE, (quote ? `"${quote}"\n\n` : '') + contents);
      isNotPlaced = true;
    };

    switch (a.kind) {
      case 'text': {
        const parts = partsOf(a);
        if (!parts) break;
        // a highlight over the same range carries the thread, one thread each. "The same range" is exact: a thread on part
        // of a longer highlight keeps its own range (a dotted underline), which a file can hold beside the highlight
        const host = liveMarks.find((m) => {
          if (m.style !== 'highlight' || claimed.has(m.id) || !markParts.has(m.id) || m.anchor.kind !== 'text') return false;
          return (m.anchor.textSource ?? 'pdfium') === (a.textSource ?? 'pdfium') && cmpPos(m.anchor.start, a.start) === 0 && cmpPos(m.anchor.end, a.end) === 0;
        });
        if (host) {
          claimed.add(host.id);
          const hostParts = markParts.get(host.id) ?? [];
          const part = hostParts.find((p) => p.pageIndex === a.start.page) ?? hostParts[0];
          if (part) {
            // the annotation's dates are the comment's: that is the date Foxit and Acrobat show on the note
            Object.assign(part.plan, { contents, author: rootAuthor, createdAt: created, modifiedAt: modified });
            rootPlan = part.plan;
            rootEntry = part.entry;
            withPopup = true;
            break;
          }
        }
        const firstPage = parts[0]?.page ?? 0;
        parts.forEach((part, k) => {
          const quads = part.rects;
          const plan: PdfAnnotationPlan = {
            ...rootBase, quads, nm: partNm(t.id, part.page, firstPage), subtype: 'Underline', pageIndex: part.page, rect: unionRect(quads), rgb: threadRgb,
            contents: k === 0 ? contents : null, author: k === 0 ? rootAuthor : null, subject: k === 0 ? SUBJ_THREAD : null, flags: ANNOT_FLAG.print, ap: { kind: 'dotted-underline' },
          };
          const e = addEntry(part.page, t.sortKey, t.createdAt, [plan]);
          if (k === 0) { rootPlan = plan; rootEntry = e; }
        });
        withPopup = true;
        break;
      }
      case 'area':
      case 'figure': {
        const parts = partsOf(a);
        const first = parts?.[0];
        if (!first) break;
        const g = first.g;
        // a pin on a figure and a part of a figure are stored 0–1 of the figure's box (spec: "Pins and sub-areas are
        // stored relative to the figure"), so they go back on the page first
        if (a.kind === 'figure' && a.sub?.point) {
          const p = pointToUser(g, withinRect(a.rect, a.sub.point));
          note(a.page, clampRectInto(g, { x: p.x, y: p.y - NOTE_ICON_SIZE, width: NOTE_ICON_SIZE, height: NOTE_ICON_SIZE }), null, contents);
          break;
        }
        const rect = a.kind === 'figure' && a.sub?.rect ? normToUser(g, rectWithin(a.rect, a.sub.rect)) : unionRect(first.rects);
        rootPlan = { ...rootBase, nm: rowNm(t.id), subtype: 'Square', pageIndex: first.page, rect, rgb: areaRgb, contents, subject: SUBJ_THREAD, flags: ANNOT_FLAG.print, ap: { kind: 'box' } };
        rootEntry = addEntry(first.page, t.sortKey, t.createdAt, [rootPlan]);
        withPopup = true;
        break;
      }
      case 'point': {
        const g = geo(a.page);
        if (!g) break;
        const p = pointToUser(g, a.point);
        note(a.page, clampRectInto(g, { x: p.x, y: p.y - NOTE_ICON_SIZE, width: NOTE_ICON_SIZE, height: NOTE_ICON_SIZE }), null, contents);
        break;
      }
      case 'page': {
        const g = geo(a.page);
        if (!g) break;
        note(a.page, marginRect(a.page, g), SUBJ_PAGE_NOTE, contents);
        break;
      }
      case 'document': {
        const g = geo(0);
        if (!g) break;
        note(0, marginRect(0, g), SUBJ_DOCUMENT_NOTE, contents);
        break;
      }
    }
    if (!rootPlan) {
      fallback();
      withPopup = false;
    }
    const rp = rootPlan;
    const re = rootEntry;
    if (!rp || !re) {
      notPlaced.push(t.id); // no geometry for its page (or for page 1): there is nowhere in the file to put it
      return;
    }
    if (isNotPlaced) notPlaced.push(t.id);

    const g = geo(rp.pageIndex)!;
    if (withPopup) {
      re.items.push({
        nm: popupNm(t.id), subtype: 'Popup', pageIndex: rp.pageIndex, rect: popupRect(g, rp.rect), quads: [], rgb: null, contents: null, author: null, subject: null,
        createdAt: created, modifiedAt: modified, irt: null, popupOf: rp.nm, flags: 0, ap: { kind: 'empty' },
      });
    }
    if (o.replies === 'threaded') {
      for (const r of replies) {
        re.items.push({
          nm: rowNm(r.id), subtype: 'Text', pageIndex: rp.pageIndex,
          rect: { x: rp.rect.x, y: rp.rect.y + rp.rect.height - REPLY_BOX, width: REPLY_BOX, height: REPLY_BOX },
          quads: [], rgb: null, contents: commentPlainText(r), author: authorName(r.author), subject: null,
          createdAt: r.createdAt, modifiedAt: r.editedAt ?? r.createdAt, irt: rp.nm, popupOf: null, flags: replyFlags, ap: { kind: 'empty' },
        });
      }
    }
  }

  entries.sort((a, b) => a.pageIndex - b.pageIndex || a.sortKey - b.sortKey || a.createdAt - b.createdAt || a.seq - b.seq);
  return { annotations: entries.flatMap((e) => e.items), notPlaced, skippedMarks };
}
