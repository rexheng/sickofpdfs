// Shared kit for the spec-blind tests of the PDF export and import mapping (Phase 8, slice 8.1).
//
// Everything here is written from the contract (section 9 and its 1 Nov note), the Phase 7-8 plan's contract additions and its
// carried requirements, and the spec's "Export and import" paragraph. None of it comes from the code under test. The types
// below are the test's own reading of the published shapes (structural, so a different spelling of a type name is no problem);
// the guesses behind them are written down in the tests report.
//
// Geometry is real: page boxes and /Rotate values are read back out of real PDF files with pdf-lib. One file is built here
// (crop boxes that do not start at 0,0, all four /Rotate values, a negative origin); the other is test-assets/mixed.pdf.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { degrees, PDFDocument } from 'pdf-lib';
import type { ClaudeReplyMeta } from '../../src/claude/types';
import type { CommentId, DocumentId, MarkId, TabId, ThreadId } from '../../src/ids';
import type { Anchor, NormRect } from '../../src/model/anchor';
import type { CommentMeta, CommentRow, MarkColor, MarkRow, MarkStyle, ThreadRow } from '../../src/model/rows';

// ---------------------------------------------------------------------------------------------------------------
// The shapes (the test's reading of plan section 9, with PdfRect renamed PdfUserRect as the carried requirements say)

export type Rgb = [number, number, number];
/** A PDF box as the PDF writes it: [llx, lly, urx, ury]. */
export type Box = [number, number, number, number];
export type Rotation = 0 | 90 | 180 | 270;
/** PageGeometry: PDF user space, origin at the lower left, y up. */
export interface GeometryLike {
  crop: Box;
  media: Box;
  rotation: Rotation;
}
/** PdfUserRect: PDF user space, y up. (x, y) is the LOWER-left corner. */
export interface UserRectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type ApKind = 'text-markup' | 'dotted-underline' | 'bold-outlines' | 'box' | 'note-icon' | 'empty';
export interface PlanLike {
  nm: string;
  subtype: 'Highlight' | 'Underline' | 'StrikeOut' | 'Square' | 'Text' | 'Popup';
  pageIndex: number;
  rect: UserRectLike;
  quads: UserRectLike[];
  rgb: Rgb | null;
  contents: string | null;
  author: string | null;
  subject: string | null;
  createdAt: number;
  modifiedAt: number;
  irt: string | null;
  popupOf: string | null;
  flags: number;
  ap: { kind: ApKind; chars?: { start: number; count: number } };
}
export type Placement = { page: number; rects: NormRect[] }[];
export interface ExportInput {
  marks: MarkRow[];
  threads: ThreadRow[];
  comments: CommentRow[];
  geometry: GeometryLike[];
  place(a: Anchor): Placement | null;
}
export interface ExportOptions {
  replies: 'threaded' | 'folded';
  markRgb: Record<MarkColor, Rgb>;
  ownerName: string;
  lineRgb?: Rgb;
  areaRgb?: Rgb;
  threadRgb?: Rgb;
  replyAppearance?: 'hidden' | 'empty';
}
export interface ExportResult {
  annotations: PlanLike[];
  notPlaced: string[];
  skippedMarks: unknown[];
}
export type PlanPdfExport = (i: ExportInput, o: ExportOptions) => ExportResult | Promise<ExportResult>;

/** PdfAnnotation, the shape the engine reads back (positions in PdfUserRect). */
export interface ReadAnnotationLike {
  objectNumber: number;
  nm: string | null;
  subtype: string;
  pageIndex: number;
  rect: UserRectLike;
  quads: UserRectLike[];
  rgb: Rgb | null;
  opacity: number | null;
  contents: string | null;
  author: string | null;
  subject: string | null;
  createdAt: number | null;
  modifiedAt: number | null;
  irtObjectNumber: number | null;
  replyType: 'R' | 'Group' | null;
  flags: number;
  hasAppearance: boolean;
}
export interface ImportRefLike {
  pdfRef: string;
  rowId: string;
  rowTable?: string;
  documentId?: string;
}
export interface ImportResultLike {
  marks: MarkRow[];
  threads: ThreadRow[];
  comments: CommentRow[];
  refs: ImportRefLike[];
  hide: { pageIndex: number; objectNumber: number }[];
  skipped: { objectNumber: number; subtype: string }[];
}
export type PlanPdfImport = (
  read: ReadAnnotationLike[],
  known: { refs: { pdfRef: string; rowId: string }[]; documentId?: DocumentId },
  anchorFor: (a: ReadAnnotationLike) => Anchor | null,
) => ImportResultLike | Promise<ImportResultLike>;

// ---------------------------------------------------------------------------------------------------------------
// Colours: deliberately not any colour a default table would hold, so a hard-coded colour shows

export const MARK_RGB: Record<MarkColor, Rgb> = {
  1: [253, 231, 37],
  2: [67, 176, 92],
  3: [61, 126, 230],
  4: [232, 62, 140],
  5: [250, 140, 20],
};
export const AREA_RGB: Rgb = [210, 40, 41];
export const THREAD_RGB: Rgb = [90, 100, 111];
export const OWNER = 'Sam Reader';

// ---------------------------------------------------------------------------------------------------------------
// Page geometry from real PDF bytes

/** The geometry of every page of a PDF, as the engine would report it: the boxes in user space, plus /Rotate. */
export async function geometryFromPdf(bytes: Uint8Array): Promise<GeometryLike[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => {
    const m = p.getMediaBox();
    const c = p.getCropBox();
    const angle = (((p.getRotation().angle % 360) + 360) % 360) as Rotation;
    return { crop: [c.x, c.y, c.x + c.width, c.y + c.height], media: [m.x, m.y, m.x + m.width, m.y + m.height], rotation: angle };
  });
}

/**
 * Five pages, none of which starts at (0, 0):
 * 0-3: media [0 0 650 850], crop [20 30 632 822] (a 612 x 792 crop box offset by 20, 30), /Rotate 0, 90, 180, 270
 * 4:   media [-30 -40 830 540], crop [-10 -20 790 480] (800 x 500, negative origin), /Rotate 90
 */
export async function generatedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const add = (media: Box, crop: Box, rotation: Rotation) => {
    const p = doc.addPage([media[2] - media[0], media[3] - media[1]]);
    p.setMediaBox(media[0], media[1], media[2] - media[0], media[3] - media[1]);
    p.setCropBox(crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1]);
    p.setRotation(degrees(rotation));
  };
  for (const r of [0, 90, 180, 270] as const) add([0, 0, 650, 850], [20, 30, 632, 822], r);
  add([-30, -40, 830, 540], [-10, -20, 790, 480], 90);
  return doc.save();
}

export const generatedGeometry = async (): Promise<GeometryLike[]> => geometryFromPdf(await generatedPdf());

/** A file from test-assets/ (gitignored; `pnpm fixtures` builds it). */
export function testAsset(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../../../../test-assets/${name}`, import.meta.url));
  if (!existsSync(path)) throw new Error(`test-assets/${name} is missing. Run \`pnpm fixtures\` at the repo root.`);
  return new Uint8Array(readFileSync(path));
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const markId = (n: number): MarkId => id(1000 + n) as MarkId;
export const threadId = (n: number): ThreadId => id(2000 + n) as ThreadId;
export const commentId = (n: number): CommentId => id(3000 + n) as CommentId;
export const DOC = 'a'.repeat(64) as DocumentId;
export const TAB = 'tab-under-test' as TabId;
const HLC = '0000000000000-0000-dev';
const T0 = 1_700_000_000_000;

export type TextAnchor = Extract<Anchor, { kind: 'text' }>;

/** A text anchor on one page, `rects` being its line rectangles (0-1 of the crop box, top-left origin). */
export function textAnchor(o: { page: number; start: number; end: number; quote: string; rects: NormRect[] }): TextAnchor {
  return {
    kind: 'text',
    quote: { quote: o.quote, prefix: '', suffix: '' },
    start: { page: o.page, index: o.start },
    end: { page: o.page, index: o.end },
    rects: o.rects.length ? [{ page: o.page, rects: o.rects }] : [],
  };
}
/** A text anchor across pages. */
export function textAnchorAcross(o: { start: { page: number; index: number }; end: { page: number; index: number }; quote: string; rects: Placement }): TextAnchor {
  return { kind: 'text', quote: { quote: o.quote, prefix: '', suffix: '' }, start: o.start, end: o.end, rects: o.rects };
}
export const areaAnchor = (page: number, rect: NormRect): Anchor => ({ kind: 'area', page, rect, dHash: '0'.repeat(16) });
export const figureAnchor = (page: number, rect: NormRect): Anchor => ({
  kind: 'figure',
  page,
  rect,
  figure: { label: 'Figure 2', captionQuote: null, imageSha256: null, dHash: '0'.repeat(16), detector: 'caption', detectorVersion: '1' },
});
export const pointAnchor = (page: number, point: [number, number]): Anchor => ({ kind: 'point', page, point });
export const pageAnchor = (page: number): Anchor => ({ kind: 'page', page });
export const documentAnchor: Anchor = { kind: 'document' };

/** One text line is 12 pt on a 792 pt page. */
export const LINE = 12 / 792;
/** `n` consecutive lines starting at y0: the first from x 0.15 to 0.85, the last from 0.15 to 0.52, those between full width. */
export function lineRects(y0: number, n: number): NormRect[] {
  const out: NormRect[] = [];
  for (let i = 0; i < n; i++) out.push([0.15, y0 + i * LINE, i === n - 1 && n > 1 ? 0.52 : 0.85, y0 + (i + 1) * LINE]);
  return out;
}

function anchorPage(a: Anchor): number | null {
  switch (a.kind) {
    case 'text':
      return a.start.page;
    case 'document':
      return null;
    default:
      return a.page;
  }
}

export function mark(o: {
  n: number;
  style: MarkStyle;
  color?: MarkColor | null;
  anchor: Anchor;
  author?: 'me' | 'claude';
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number | null;
}): MarkRow {
  return {
    id: markId(o.n),
    documentId: DOC,
    style: o.style,
    color: o.color !== undefined ? o.color : o.style === 'bold' || o.style === 'area' ? null : 1,
    anchor: o.anchor,
    pageIndex: anchorPage(o.anchor) ?? 0,
    sortKey: o.n,
    author: o.author ?? 'me',
    createdAt: o.createdAt ?? T0 + o.n,
    updatedAt: o.updatedAt ?? T0 + o.n + 500,
    rev: 1,
    hlc: HLC,
    deletedAt: o.deletedAt ?? null,
  };
}

export function thread(o: { n: number; anchor: Anchor; createdAt?: number; deletedAt?: number | null; draftOfTab?: TabId | null }): ThreadRow {
  return {
    id: threadId(o.n),
    documentId: DOC,
    anchor: o.anchor,
    pageIndex: anchorPage(o.anchor),
    sortKey: o.n,
    placement: 'placed',
    draftOfTab: o.draftOfTab ?? null,
    createdAt: o.createdAt ?? T0 + o.n,
    updatedAt: o.createdAt ?? T0 + o.n,
    rev: 1,
    hlc: HLC,
    deletedAt: o.deletedAt ?? null,
  };
}

export function comment(o: {
  n: number;
  thread: number;
  body: string;
  createdAt: number;
  author?: 'me' | 'claude';
  editedAt?: number | null;
  deletedAt?: number | null;
  draftOfTab?: TabId | null;
  meta?: CommentMeta;
}): CommentRow {
  return {
    id: commentId(o.n),
    threadId: threadId(o.thread),
    documentId: DOC,
    author: o.author ?? 'me',
    body: o.body,
    draftOfTab: o.draftOfTab ?? null,
    meta: o.meta ?? {},
    createdAt: o.createdAt,
    editedAt: o.editedAt ?? null,
    rev: 1,
    hlc: HLC,
    deletedAt: o.deletedAt ?? null,
  };
}

export const claudeMeta = (o: Partial<ClaudeReplyMeta> = {}): ClaudeReplyMeta => ({
  kind: 'claude-reply',
  v: 1,
  role: 'default',
  status: 'done',
  error: null,
  questionId: null,
  citations: [],
  webSources: [],
  usage: null,
  scope: 'passages',
  figureLabels: [],
  via: 'viewer',
  ...o,
});

/** What a resolver hands back for a stored anchor when the same bytes are open: the stored rectangles. No geometry, no placement. */
export function identityPlace(a: Anchor): Placement | null {
  switch (a.kind) {
    case 'text':
      return a.rects.length ? a.rects : null;
    case 'area':
    case 'figure':
      return [{ page: a.page, rects: [a.rect] }];
    case 'point':
      return [{ page: a.page, rects: [[a.point[0], a.point[1], a.point[0], a.point[1]]] }];
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Looking at the output

export const toX = (r: UserRectLike) => ({ x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height });

/** The reference conversion, written out once: 0-1 of the crop box, top-left origin  ->  PDF user space, y up. */
export function userRectOf(n: NormRect, crop: Box): UserRectLike {
  const w = crop[2] - crop[0];
  const h = crop[3] - crop[1];
  return { x: crop[0] + n[0] * w, y: crop[3] - n[3] * h, width: (n[2] - n[0]) * w, height: (n[3] - n[1]) * h };
}

/** Upper lines first (larger y first), so quads compare without depending on their order. */
export const topFirst = (rs: UserRectLike[]): UserRectLike[] => [...rs].sort((a, b) => b.y - a.y || a.x - b.x);

export const HIDDEN = 2;
export const hasFlag = (flags: number, bit: number): boolean => (flags & bit) !== 0;

export function subtypes(r: ExportResult, s: PlanLike['subtype']): PlanLike[] {
  return r.annotations.filter((a) => a.subtype === s);
}

/** The ids in skippedMarks, whether it holds ids or objects that carry one. */
export function skippedIds(r: ExportResult): string[] {
  return r.skippedMarks.map((s) => {
    if (typeof s === 'string') return s;
    const o = s as { id?: string; markId?: string };
    return o.id ?? o.markId ?? JSON.stringify(s);
  });
}

/** The row id an /NM names: `sop:<id>` or `sop:<id>~<page>`. */
export const rowIdOfNm = (nm: string): string => nm.replace(/^sop:/, '').replace(/~\d+$/, '');
export const isExportedFor = (r: ExportResult, rowId: string): boolean => r.annotations.some((a) => a.nm === `sop:${rowId}` || a.nm.startsWith(`sop:${rowId}~`));

// ---------------------------------------------------------------------------------------------------------------
// The engine's side of a round trip: what readAnnotations would hand back for the annotations we wrote

export function readBack(plans: PlanLike[], firstObject = 20): ReadAnnotationLike[] {
  const objectOf = new Map(plans.map((p, i) => [p.nm, firstObject + i]));
  return plans.map((p, i) => ({
    objectNumber: firstObject + i,
    nm: p.nm,
    subtype: p.subtype,
    pageIndex: p.pageIndex,
    rect: p.rect,
    quads: p.quads,
    rgb: p.rgb,
    opacity: null,
    contents: p.contents,
    author: p.author,
    subject: p.subject,
    createdAt: p.createdAt,
    modifiedAt: p.modifiedAt,
    irtObjectNumber: p.irt ? (objectOf.get(p.irt) ?? null) : null,
    replyType: p.irt ? 'R' : null,
    flags: p.flags,
    hasAppearance: true,
  }));
}

/** An annotation another tool wrote (Foxit, Acrobat, a browser): only the fields a test cares about are given. */
export function foreign(o: Partial<ReadAnnotationLike> & { objectNumber: number; subtype: string; pageIndex: number }): ReadAnnotationLike {
  return {
    nm: null,
    rect: { x: 100, y: 600, width: 200, height: 14 },
    quads: [],
    rgb: null,
    opacity: null,
    contents: null,
    author: null,
    subject: null,
    createdAt: null,
    modifiedAt: null,
    irtObjectNumber: null,
    replyType: null,
    flags: 4,
    hasAppearance: true,
    ...o,
  };
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
