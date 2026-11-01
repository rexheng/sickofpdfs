// Notes already in a PDF become editable notes, once (contracts §9, spec "Export and import"): pure, no engine, no store.
// Slice 8.4 reads the file's annotations (`PdfBackend.readAnnotations`), calls this, and writes what it returns in one
// transaction (`applyImport`); it then hides the annotations in `hide` in the open handle, so nothing draws twice.
//
// What becomes what (the reverse of pdf-mapping.ts):
//   /Highlight /Underline /StrikeOut /Squiggly  → a mark (squiggly reads as underline); with /Contents or replies, a thread too
//   /Underline or /Square with /Subj (Comment)  → a thread that was a dotted-underline or outline root of ours: no mark
//   /Square with /Subj (Bold)                   → a bold mark
//   other /Square                               → an area mark (and a thread when it has text)
//   /Text with no /IRT                          → a thread: a note (/Subj Document note), a page note (/Subj Page note), or a pin
//   /Text with /IRT and /RT /R                  → a reply on its root's thread, in time order; a reply to a reply joins the root
//   everything else (FreeText, Ink, Stamp, Line, Circle, Link, widgets, grouped annotations, empty replies)
//                                               → `skipped`: left as it is, drawn by the page
// Parts of a mark on several pages (/NM sop:<id>, sop:<id>~<page>) come back as one mark.
//
// IDS AND DE-DUPLICATION. A mark, a dedicated thread root and a reply keep the UUID in their /NM (`sop:<uuid>`) as the row
// id, unless the library already has that id. Anything else gets an id made from the annotation's name (`derivedId`), the
// same each time. `known.refs` are the annotations imported before (`pdf_import_refs`); they make no rows, but are in
// `hide` again, because hiding lasts only as long as the open handle.
//
// REFS. One per annotation, plus `<ref>#thread` and `<ref>#root` for the thread and first comment made from a mark's
// annotation, so that Undo can find every row an import made.
import type { DocumentId, MarkId, ThreadId, CommentId } from '../ids';
import type { Anchor, CharPos, NormRect } from '../model/anchor';
import type { CommentMeta, CommentRow, MarkColor, MarkRow, MarkStyle, ThreadRow } from '../model/rows';
import { CLAUDE_LABEL, SUBJ_BOLD, SUBJ_DOCUMENT_NOTE, SUBJ_PAGE_NOTE, SUBJ_THREAD, derivedId, parseNm, pdfRefOf } from './nm';
import { plainToMarkdown } from './note-text';
import type { PdfUserRect, Rgb } from './pdf-mapping';

/**
 * Contracts §9: one annotation as the engine reads it. `rect` and `quads` are in PDF user space like the file's /Rect and
 * /QuadPoints ({ x, y } is the lower-left corner; `PdfUserRect`, not the engine's `PdfRect`); a quad is the axis-aligned box of its four points. `rgb` is /C as
 * 0–255. Slice 8.2 declares the same shape in backend/types.ts.
 */
export interface PdfAnnotation {
  objectNumber: number;
  nm: string | null;
  subtype: string;
  pageIndex: number;
  rect: PdfUserRect;
  quads: PdfUserRect[];
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

/** Contracts §9: what an imported comment remembers of the PDF. The PDF's author is a label; `author` stays 'me'. */
export interface ImportedMeta {
  kind: 'pdf-import';
  v: 1;
  author: string | null;
  ref: string;
  modifiedAt: number | null;
}

/** A `pdf_import_refs` row. */
export interface ImportRef {
  documentId: DocumentId;
  pdfRef: string;
  rowTable: 'marks' | 'threads' | 'comments';
  rowId: string;
}

export interface PdfImportOptions {
  /** Stamped on every row and ref. Left out, rows carry '' and the caller fills it (the store stamps `rev` and `hlc` as well). */
  documentId?: DocumentId;
  /** The five mark fills, to find the nearest slot of an annotation's colour. Left out, the slot is found by hue alone. */
  markRgb?: Record<MarkColor, Rgb>;
  /** Used for a row whose annotation has no date. Default 0. */
  now?: number;
  /** Makes an id from a seed. Default: `derivedId`. */
  newId?: (seed: string) => string;
  /** Read /T "Claude" on our own annotations back as author 'claude'. Default false: imported rows keep author 'me' (contracts §9). */
  keepClaudeAuthor?: boolean;
}

export interface PdfImportPlan {
  marks: MarkRow[];
  threads: ThreadRow[];
  comments: CommentRow[];
  refs: ImportRef[];
  hide: { pageIndex: number; objectNumber: number }[];
  skipped: { objectNumber: number; subtype: string }[];
}

type TextAnchor = Extract<Anchor, { kind: 'text' }>;

// ---- colour ----

/** Hue of each of the five slots, in degrees: yellow, green, blue, pink, orange (the hues of the --sop-mark-N fills). */
const SLOT_HUE: Record<MarkColor, number> = { 1: 44, 2: 136, 3: 201, 4: 326, 5: 29 };

function hueOf([r, g, b]: Rgb): { hue: number; sat: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  if (d === 0) return { hue: 0, sat: 0 };
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  const l = (max + min) / 2;
  return { hue: h, sat: d / (1 - Math.abs(2 * l - 1)) };
}

/** The nearest of the five slots: by distance to `palette` when given, else by hue. No colour, or a grey, is slot 1 (yellow). */
export function nearestMarkColor(rgb: Rgb | null, palette?: Record<MarkColor, Rgb>): MarkColor {
  if (!rgb) return 1;
  const slots: MarkColor[] = [1, 2, 3, 4, 5];
  if (palette) {
    let best: MarkColor = 1, bestD = Infinity;
    for (const s of slots) {
      const p = palette[s];
      // a weighted RGB distance ("redmean"): close to how the eye sees it, and needs no colour-space tables
      const rm = (rgb[0] + p[0]) / 2;
      const dr = rgb[0] - p[0], dg = rgb[1] - p[1], db = rgb[2] - p[2];
      const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }
  const { hue, sat } = hueOf(rgb);
  if (sat < 0.12) return 1;
  let best: MarkColor = 1, bestD = Infinity;
  for (const s of slots) {
    const d = Math.min(Math.abs(hue - SLOT_HUE[s]), 360 - Math.abs(hue - SLOT_HUE[s]));
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// ---- anchors ----

/** The page a row belongs to and where it sits on it (0 to 1), for ordering: the same as the viewer's own rows. */
function placeOf(a: Anchor): { pageIndex: number | null; sortKey: number | null } {
  switch (a.kind) {
    case 'text': {
      const onStart = a.rects.find((r) => r.page === a.start.page) ?? a.rects[0];
      return { pageIndex: a.start.page, sortKey: onStart?.rects[0]?.[1] ?? 0 };
    }
    case 'area':
    case 'figure': return { pageIndex: a.page, sortKey: a.rect[1] };
    case 'point': return { pageIndex: a.page, sortKey: a.point[1] };
    case 'page': return { pageIndex: a.page, sortKey: 0 };
    case 'document': return { pageIndex: null, sortKey: null };
  }
}

const cmpPos = (a: CharPos, b: CharPos): number => (a.page !== b.page ? a.page - b.page : a.index - b.index);

/** The parts of a mark on several pages, one text anchor each, as one anchor (a quote across pages joins with '\n', as buildTextAnchor does). */
function mergeTextAnchors(parts: TextAnchor[]): TextAnchor {
  const first = parts[0];
  if (!first) throw new Error('a mark has at least one part');
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1] ?? first;
  const rects: { page: number; rects: NormRect[] }[] = [];
  for (const p of parts) for (const r of p.rects) {
    const into = rects.find((x) => x.page === r.page);
    if (into) into.rects.push(...r.rects);
    else rects.push({ page: r.page, rects: [...r.rects] });
  }
  const start = parts.reduce((m, p) => (cmpPos(p.start, m) < 0 ? p.start : m), first.start);
  const end = parts.reduce((m, p) => (cmpPos(p.end, m) > 0 ? p.end : m), last.end);
  const merged: TextAnchor = { kind: 'text', quote: { quote: parts.map((p) => p.quote.quote).join('\n'), prefix: first.quote.prefix, suffix: last.quote.suffix }, start, end, rects };
  if (first.textSource !== undefined) merged.textSource = first.textSource;
  return merged;
}

// ---- the plan ----

const MARKUP: Record<string, MarkStyle> = { Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strike', Squiggly: 'underline' };
const REPLY_NOTES = new Set(['Text']);

interface Group {
  /** Parts in page order; the first is the primary: the one with the text and the replies. */
  parts: PdfAnnotation[];
}

export function planPdfImport(
  read: readonly PdfAnnotation[],
  known: { refs: readonly { pdfRef: string; rowId: string }[] },
  anchorFor: (a: PdfAnnotation) => Anchor | null,
  o: PdfImportOptions = {},
): PdfImportPlan {
  const documentId = o.documentId ?? ('' as DocumentId);
  const mint = o.newId ?? derivedId;
  const now = o.now ?? 0;
  const knownRows = new Map(known.refs.map((r) => [r.pdfRef, r.rowId]));
  const usedIds = new Set(known.refs.map((r) => r.rowId));
  const plan: PdfImportPlan = { marks: [], threads: [], comments: [], refs: [], hide: [], skipped: [] };
  const hidden = new Set<number>();
  const hide = (a: PdfAnnotation): void => {
    if (hidden.has(a.objectNumber)) return;
    hidden.add(a.objectNumber);
    plan.hide.push({ pageIndex: a.pageIndex, objectNumber: a.objectNumber });
  };
  const addRef = (pdfRef: string, rowTable: ImportRef['rowTable'], rowId: string): void => {
    plan.refs.push({ documentId, pdfRef, rowTable, rowId });
  };
  /** The id a row gets: the UUID in the /NM when it is free, else one made from `seed`. */
  const takeId = (a: PdfAnnotation, seed: string): string => {
    const parsed = parseNm(a.nm);
    let id = parsed && parsed.part.kind !== 'popup' ? parsed.rowId : mint(seed);
    if (usedIds.has(id)) id = mint(`${seed}#again`);
    usedIds.add(id);
    return id;
  };
  const text = (a: PdfAnnotation): string => (a.contents ?? '').replace(/\r\n?/g, '\n').trim();

  // 1. replies, by the root they answer (a reply to a reply joins the root)
  const byObject = new Map<number, PdfAnnotation>();
  for (const a of read) byObject.set(a.objectNumber, a);
  const rootOf = (a: PdfAnnotation): PdfAnnotation | null => {
    let cur: PdfAnnotation | undefined = a;
    for (let hops = 0; cur && cur.irtObjectNumber !== null && hops < 64; hops++) cur = byObject.get(cur.irtObjectNumber);
    return cur && cur.irtObjectNumber === null ? cur : null;
  };
  const repliesOf = new Map<number, PdfAnnotation[]>();
  const isReply = (a: PdfAnnotation): boolean => a.irtObjectNumber !== null && a.replyType !== 'Group' && REPLY_NOTES.has(a.subtype) && text(a) !== '';
  for (const a of read) {
    if (a.irtObjectNumber === null || !isReply(a)) continue;
    const root = rootOf(a);
    if (!root || root.objectNumber === a.objectNumber) continue;
    const list = repliesOf.get(root.objectNumber);
    if (list) list.push(a);
    else repliesOf.set(root.objectNumber, [a]);
  }
  const time = (a: PdfAnnotation): number => a.createdAt ?? a.modifiedAt ?? 0;
  for (const list of repliesOf.values()) list.sort((a, b) => time(a) - time(b) || a.objectNumber - b.objectNumber);

  // 2. the roots, with the parts of a mark on several pages grouped
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  const consumed = new Set<number>(); // replies taken by a root
  for (const a of read) {
    if (a.subtype === 'Popup') continue;
    if (a.irtObjectNumber !== null) continue; // replies are handled with their roots
    const importable = a.subtype in MARKUP || a.subtype === 'Square' || a.subtype === 'Text';
    if (!importable) { plan.skipped.push({ objectNumber: a.objectNumber, subtype: a.subtype }); continue; }
    const parsed = parseNm(a.nm);
    const threadOnly = a.subtype === 'Underline' && a.subject === SUBJ_THREAD;
    const mergeable = parsed !== null && parsed.part.kind !== 'popup' && (a.subtype in MARKUP || (a.subtype === 'Square' && a.subject === SUBJ_BOLD));
    const key = mergeable ? `${threadOnly ? 'thread' : a.subject === SUBJ_BOLD ? 'bold' : a.subtype}:${parsed.rowId}` : `one:${a.objectNumber}`;
    const g = byKey.get(key);
    if (g) g.parts.push(a);
    else { const ng: Group = { parts: [a] }; byKey.set(key, ng); groups.push(ng); }
  }
  for (const g of groups) g.parts.sort((x, y) => (parseNm(x.nm)?.part.kind === 'row' ? -1 : 0) - (parseNm(y.nm)?.part.kind === 'row' ? -1 : 0) || x.pageIndex - y.pageIndex || x.objectNumber - y.objectNumber);

  // 3. each group
  for (const g of groups) {
    const primary = g.parts[0];
    if (!primary) continue;
    const refs = g.parts.map(pdfRefOf);
    const ref0 = refs[0] ?? pdfRefOf(primary);
    const replies = (g.parts.flatMap((p) => repliesOf.get(p.objectNumber) ?? [])).sort((a, b) => time(a) - time(b) || a.objectNumber - b.objectNumber);
    const alreadyKnown = knownRows.has(ref0);
    if (alreadyKnown) {
      // imported before: no rows, but still hidden. A reply added since is attached to the thread it was on.
      g.parts.forEach(hide);
      const threadId = knownRows.get(`${ref0}#thread`) ?? knownRows.get(ref0);
      for (const r of replies) {
        const ref = pdfRefOf(r);
        hide(r);
        if (knownRows.has(ref) || !threadId) continue;
        const id = takeId(r, `${ref}#comment`);
        plan.comments.push(commentRow(r, id, threadId as ThreadId, ref));
        addRef(ref, 'comments', id);
      }
      continue;
    }

    // only our own export marks a root as a thread's (another app's "Comment" subject is just a subject)
    const isThreadOnly = primary.subject === SUBJ_THREAD && (primary.subtype === 'Underline' || primary.subtype === 'Square') && parseNm(primary.nm) !== null;
    const isBold = primary.subtype === 'Square' && primary.subject === SUBJ_BOLD;
    const body = text(primary);
    const isNote = primary.subtype === 'Text';
    if (isNote && body === '' && replies.length === 0) { plan.skipped.push({ objectNumber: primary.objectNumber, subtype: primary.subtype }); continue; }

    // the anchor
    let anchor: Anchor | null;
    if (isNote) {
      if (primary.subject === SUBJ_DOCUMENT_NOTE) anchor = { kind: 'document' };
      else if (primary.subject === SUBJ_PAGE_NOTE) anchor = { kind: 'page', page: primary.pageIndex };
      else anchor = anchorFor(primary) ?? { kind: 'page', page: primary.pageIndex };
    } else if (primary.subtype === 'Square' && !isBold) {
      anchor = anchorFor(primary);
    } else {
      const parts: TextAnchor[] = [];
      for (const p of g.parts) {
        const part = anchorFor(p);
        if (!part || part.kind !== 'text') { parts.length = 0; break; }
        parts.push(part);
      }
      anchor = parts.length === g.parts.length ? mergeTextAnchors(parts) : null;
    }
    if (!anchor) { for (const p of g.parts) plan.skipped.push({ objectNumber: p.objectNumber, subtype: p.subtype }); continue; }

    const created = primary.createdAt ?? primary.modifiedAt ?? now;
    const updated = primary.modifiedAt ?? created;
    const makesMark = !isNote && !isThreadOnly;
    const makesThread = isNote || isThreadOnly || body !== '' || replies.length > 0;

    let markId: MarkId | null = null;
    if (makesMark) {
      const style: MarkStyle = isBold ? 'bold' : primary.subtype === 'Square' ? 'area' : (MARKUP[primary.subtype] ?? 'highlight');
      const color: MarkColor | null = style === 'bold' || style === 'area' ? null : nearestMarkColor(primary.rgb, o.markRgb);
      markId = takeId(primary, `${ref0}#mark`) as MarkId;
      const where = placeOf(anchor);
      plan.marks.push({
        rev: 0, hlc: '', deletedAt: null, id: markId, documentId, style, color, anchor, pageIndex: where.pageIndex ?? 0, sortKey: where.sortKey ?? 0,
        author: 'me', createdAt: created, updatedAt: updated,
      });
      g.parts.forEach((p, k) => addRef(refs[k] ?? pdfRefOf(p), 'marks', markId ?? ''));
    }
    if (makesThread) {
      const dedicated = isThreadOnly || isNote;
      const threadId = (dedicated ? takeId(primary, `${ref0}#thread`) : mint(`${ref0}#thread`)) as ThreadId;
      if (!dedicated) usedIds.add(threadId);
      const where = placeOf(anchor);
      plan.threads.push({
        rev: 0, hlc: '', deletedAt: null, id: threadId, documentId, anchor: structuredClone(anchor), pageIndex: where.pageIndex, sortKey: where.sortKey, placement: 'placed', draftOfTab: null,
        createdAt: created, updatedAt: Math.max(updated, ...replies.map((r) => r.modifiedAt ?? 0)),
      });
      if (dedicated) g.parts.forEach((p, k) => addRef(refs[k] ?? pdfRefOf(p), 'threads', threadId));
      else addRef(`${ref0}#thread`, 'threads', threadId);
      const rootId = mint(`${ref0}#root`) as CommentId;
      usedIds.add(rootId);
      plan.comments.push(commentRow(primary, rootId, threadId, ref0, body));
      addRef(`${ref0}#root`, 'comments', rootId);
      for (const r of replies) {
        const ref = pdfRefOf(r);
        const id = takeId(r, `${ref}#comment`);
        plan.comments.push(commentRow(r, id, threadId, ref));
        addRef(ref, 'comments', id);
        hide(r);
      }
    }
    g.parts.forEach(hide);
    for (const r of replies) consumed.add(r.objectNumber);
  }

  // 4. replies whose root was not imported stay as they are
  for (const a of read) {
    if (a.irtObjectNumber === null || hidden.has(a.objectNumber) || consumed.has(a.objectNumber)) continue;
    if (a.subtype === 'Popup') continue;
    plan.skipped.push({ objectNumber: a.objectNumber, subtype: a.subtype });
  }
  return plan;

  function commentRow(a: PdfAnnotation, id: string, threadId: ThreadId, ref: string, bodyText?: string): CommentRow {
    const created = a.createdAt ?? a.modifiedAt ?? now;
    const edited = a.modifiedAt !== null && a.modifiedAt > created ? a.modifiedAt : null;
    const meta: ImportedMeta = { kind: 'pdf-import', v: 1, author: a.author, ref, modifiedAt: a.modifiedAt };
    const ours = parseNm(a.nm) !== null;
    return {
      rev: 0, hlc: '', deletedAt: null, id: id as CommentId, threadId, documentId,
      author: o.keepClaudeAuthor && ours && a.author === CLAUDE_LABEL ? 'claude' : 'me',
      body: plainToMarkdown(bodyText ?? text(a)), draftOfTab: null, meta: meta as unknown as CommentMeta, createdAt: created, editedAt: edited,
    };
  }
}
