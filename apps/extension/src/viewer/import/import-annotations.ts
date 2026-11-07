// "Import on open" (Phase 8, slice 8.4): the notes a PDF already holds as annotations become notes you can work with, once,
// and are drawn once.
//
// Two cases, one flow (contracts §9, core/export/pdf-import.ts):
// - OUR OWN COPY ("Download with notes"). Its annotations carry /NM `sop:<id>`. Where the library already has that row (even a
//   deleted one), nothing is added and the file's own drawing is hidden, so the mark shows once. A mark or thread the library
//   does not have (the copy was made on another computer) is added as a new note.
// - SOMEONE ELSE'S. Highlights, underlines, strikeouts and notes with replies from Foxit, Acrobat or a classmate are added as
//   notes with their author's name as a label. Everything else (FreeText, Ink, Stamp, links, form fields) stays as the file draws it.
//
// Rules: import only inserts (a row that exists is never changed; an id that is taken gives the new note another id). It runs
// only for a PDF that is SAVED in the library: a PDF that is not saved shows the file's annotations as they are, in its tab,
// and nothing is written. "Undo" on the snackbar removes what the import added and leaves the file as it was.
import {
  type Anchor,
  type DocumentId,
  type NormRect,
  parseNm,
  type PageGeometry,
  type PdfAnnotation,
  pdfRefOf,
  planPdfImport,
  type PdfImportPlan,
  SUBJ_BOLD,
  userToNorm,
} from '@sop/core';
import type { CharRange } from '@sop/viewer';
import type { StoreClient } from '../../store/client';
import { IMPORT_DECLINED_REF } from '../../store/annotations';
import type { NotesHost } from '../annotations/wire';

/** The kinds of annotation worth reading; links, widgets, stamps and the rest are never imported. */
const WANTED = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Square', 'Text', 'Popup']);
/** FPDF_ANNOT_FLAG_HIDDEN | NOVIEW: the file itself does not draw it, so there is nothing to show twice. */
const NOT_DRAWN = 2 | 32;
/** Pages read at once, and the most notes kept from one file (a file with more is mostly a form or a scan layer). */
const PAGES_AT_ONCE = 12;
const MAX_ANNOTATIONS = 6000;

/** What an import did, for the snackbar. */
export interface ImportOutcome {
  /** Notes added (a mark or a note; the comments inside them are not counted). */
  notes: number;
  /** Takes the added notes away again and draws the file's own annotations as before. */
  undo(): Promise<void>;
}

const later = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Every annotation worth importing, page by page, a few pages at a time so the page list stays smooth. Null when stopped. */
async function readAnnotations(host: NotesHost, live: () => boolean): Promise<PdfAnnotation[] | null> {
  const out: PdfAnnotation[] = [];
  const n = host.pages.length;
  for (let from = 0; from < n; from += PAGES_AT_ONCE) {
    if (!live()) return null;
    const batch = await Promise.all(
      Array.from({ length: Math.min(PAGES_AT_ONCE, n - from) }, (_, k) => host.backend.readAnnotations(host.doc, from + k).catch(() => [] as PdfAnnotation[])),
    );
    for (const list of batch) for (const a of list) if (WANTED.has(a.subtype) && (a.flags & NOT_DRAWN) === 0 && out.length < MAX_ANNOTATIONS) out.push(a);
    await later();
  }
  return out;
}

/** The chars whose centre lies in one of the quads (user space) of a page, as one range; null when there are none. */
async function charRangeInRects(host: NotesHost, g: PageGeometry, pageIndex: number, rects: PdfAnnotation['quads']): Promise<CharRange | null> {
  const size = host.pages[pageIndex];
  if (!size) return null;
  const boxes = rects.map((r) => userToNorm(g, r));
  const { glyphs } = await host.pageText.glyphs(pageIndex);
  let lo = Infinity;
  let hi = -1;
  for (const gl of glyphs) {
    const b = gl.box;
    if (b.width <= 0 || b.height <= 0) continue;
    const cx = (b.x + b.width / 2) / size.width;
    const cy = (b.y + b.height / 2) / size.height;
    if (boxes.some((q) => cx >= q[0] && cx <= q[2] && cy >= q[1] && cy <= q[3])) {
      lo = Math.min(lo, gl.index);
      hi = Math.max(hi, gl.index);
    }
  }
  return hi < 0 ? null : { pageIndex, start: lo, end: hi + 1 };
}

/** Where each annotation that will become a note sits, worked out ahead because `planPdfImport` asks for it in one go. */
async function anchorsFor(host: NotesHost, annots: readonly PdfAnnotation[], skip: (a: PdfAnnotation) => boolean): Promise<Map<number, Anchor | null>> {
  const out = new Map<number, Anchor | null>();
  const geometry = new Map<number, Promise<PageGeometry>>();
  const geometryOf = (p: number): Promise<PageGeometry> => {
    let g = geometry.get(p);
    if (!g) geometry.set(p, (g = host.backend.getPageGeometry(host.doc, p)));
    return g;
  };
  for (const a of annots) {
    if (a.subtype === 'Popup' || a.irtObjectNumber !== null || skip(a)) continue;
    try {
      const g = await geometryOf(a.pageIndex);
      if (a.subtype === 'Text') {
        const r = userToNorm(g, a.rect);
        out.set(a.objectNumber, { kind: 'point', page: a.pageIndex, point: [r[0], r[1]] });
      } else if (a.subtype === 'Square' && a.subject !== SUBJ_BOLD) {
        const rect: NormRect = userToNorm(g, a.rect);
        const dHash = await host.figures.dHash(a.pageIndex, rect).catch(() => '');
        out.set(a.objectNumber, { kind: 'area', page: a.pageIndex, rect, dHash });
      } else {
        // a text mark (or our bold square): the words under its quads
        const range = await charRangeInRects(host, g, a.pageIndex, a.quads.length > 0 ? a.quads : [a.rect]);
        out.set(a.objectNumber, range ? await host.textAnchor([range]) : null);
      }
    } catch {
      out.set(a.objectNumber, null); // left as the file draws it
    }
  }
  return out;
}

/** The number a reader is told: marks, plus notes that are not on a mark (a comment on a mark is part of the mark). */
function noteCount(plan: PdfImportPlan, added: { marks: string[]; threads: string[] }): number {
  const onMark = new Set(plan.refs.filter((r) => r.rowTable === 'threads' && r.pdfRef.endsWith('#thread')).map((r) => r.rowId));
  return added.marks.length + added.threads.filter((id) => !onMark.has(id)).length;
}

/**
 * Reads the file's annotations, adds the notes the library lacks, and hides the file's own drawing of every annotation the
 * library now shows. `documentId` is the library id of this (saved) PDF. Returns what was added, or null when there was
 * nothing to add (the file's annotations may still have been hidden). Throws when the library would not take the notes: then
 * nothing is hidden, so nothing is lost from view.
 */
export async function importOnOpen(host: NotesHost, store: StoreClient, documentId: DocumentId, live: () => boolean): Promise<ImportOutcome | null> {
  const read = await readAnnotations(host, live);
  if (read === null || read.length === 0 || !live()) return null;

  // What the library has for the ids in the file.
  const ids = read.flatMap((a) => {
    const p = parseNm(a.nm);
    return p ? [p.rowId] : [];
  });
  const ctx = await store.importContext(documentId, ids);
  const declined = ctx.refs.some((r) => r.pdfRef === IMPORT_DECLINED_REF);
  // After Undo only our own copies are matched (and hidden); other apps' notes are left as drawn.
  const annots = declined ? read.filter((a) => parseNm(a.nm) !== null) : read;

  const refs = new Map<string, string>(ctx.refs.filter((r) => r.pdfRef !== IMPORT_DECLINED_REF).map((r) => [r.pdfRef, r.rowId]));
  const own = new Map(ctx.own.map((o) => [o.id, o]));
  const byObject = new Map(annots.map((a) => [a.objectNumber, a]));
  for (const a of annots) {
    const p = parseNm(a.nm);
    const row = p ? own.get(p.rowId) : undefined;
    if (!a.nm || !row || p?.part.kind === 'popup') continue;
    refs.set(a.nm, row.id);
    // a reply the library has tells which thread its root's note belongs to
    const root = a.irtObjectNumber === null ? undefined : byObject.get(a.irtObjectNumber);
    if (root && row.threadId) refs.set(`${pdfRefOf(root)}#thread`, row.threadId);
  }
  // ids that other readings use: the new rows must take other ids
  for (const id of ctx.elsewhere) refs.set(`other:${id}`, id);

  const anchors = await anchorsFor(host, annots, (a) => refs.has(pdfRefOf(a)));
  if (!live()) return null;
  const plan = planPdfImport(
    annots,
    { refs: [...refs].map(([pdfRef, rowId]) => ({ pdfRef, rowId })) },
    (a) => anchors.get(a.objectNumber) ?? null,
    { documentId, now: Date.now() }, // colours by hue (no palette): an underline or strikeout line is darker than its fill, and hue tells them the same
  );
  if (plan.hide.length === 0 && plan.marks.length + plan.threads.length + plan.comments.length === 0) return null;

  // Add first, hide after: if the library says no, the file's drawing stays and nothing is lost from view.
  const rows = plan.marks.length + plan.threads.length + plan.comments.length > 0;
  const added = rows ? await store.applyImport(documentId, { marks: plan.marks, threads: plan.threads, comments: plan.comments, refs: plan.refs }) : { marks: [], threads: [], comments: [] };
  if (!live()) return null;
  await host.backend.setAnnotationsHidden(host.doc, plan.hide, true);
  host.pageList.current?.redrawPages();

  const notes = noteCount(plan, added);
  if (added.marks.length + added.threads.length + added.comments.length === 0) return null;
  // Undo shows the file's drawing of exactly what it added, and no more.
  const addedIds = new Set([...added.marks, ...added.threads, ...added.comments]);
  const newRefs = new Set(plan.refs.filter((r) => addedIds.has(r.rowId)).map((r) => r.pdfRef));
  const unhide = plan.hide.filter((h) => {
    const a = annots.find((x) => x.objectNumber === h.objectNumber && x.pageIndex === h.pageIndex);
    return a !== undefined && newRefs.has(pdfRefOf(a));
  });
  return {
    notes,
    async undo() {
      await store.undoImport(documentId, added);
      await host.backend.setAnnotationsHidden(host.doc, unhide, false);
      host.pageList.current?.redrawPages();
    },
  };
}
