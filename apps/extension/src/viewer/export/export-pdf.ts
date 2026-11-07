// "Download with notes" (Phase 8, slice 8.3): a copy of the open PDF with the owner's marks and comment threads written in
// as standard PDF annotations, which Foxit, Acrobat and Chrome's own viewer show.
//
// The flow (plan 8.3): gather the notes as this tab holds them (live, sent rows and where each one is drawn in these
// bytes); plan the annotations (planPdfExport, contracts §9); draw bold marks in the screen's synthetic bold
// (getGlyphShapes, marks/bold-vector.ts); write them into a copy (PdfBackend.writeAnnotations: its own handle, tail-only
// incremental save); download "<name> (with notes).pdf".
//
// The original is never changed: the copy starts with the original's own bytes, unchanged, and the stored copy in the
// library is only read. Privacy: the notes come from this tab's memory, so a PDF that is not saved can be exported from
// its tab, and nothing new is stored about it. The one thing kept is the owner's name on the notes (author-name.ts),
// which belongs to no PDF.
import { type Anchor, commentPlainText, type MarkColor, type NormRect, type NormRectsByPage, type PageGeometry, planPdfExport, type PdfAnnotationPlan, type Rgb } from '@sop/core';
import { type ApFill, boldVectorFills } from '@sop/viewer';
import type { NotesHost } from '../annotations/wire';
import { markNormRects } from '../annotations/anchor-context';
import { absoluteRect } from '../figures/anchors';

/** Chars read either side of a bold range, so its end glyphs know their neighbours (drawBoldRange's NEIGHBOUR_CHARS). */
const NEIGHBOUR_CHARS = 2;
/** A bold range that runs to the end of its page (pdf-mapping's TO_PAGE_END); the engine clamps it. */
const TO_PAGE_END = 2 ** 30;

/** What an export made: the file and what the owner should be told about it. */
export interface ExportResult {
  blob: Blob;
  fileName: string;
  /** Annotations written (pop-ups and replies included). */
  annotations: number;
  /** Comments whose words could not be found in this file: they went in as notes at the top of their page. */
  notPlaced: number;
  /** Marks that could not be found in this file, so are not in it. */
  skippedMarks: number;
}

/** The colours of the marks as the screen paints them, read from the page's own tokens (no hex in code). */
export function markColours(): { markRgb: Record<MarkColor, Rgb>; lineRgb: Record<MarkColor, Rgb>; areaRgb: Rgb; threadRgb: Rgb } {
  // A probe marked light, as print-marks.ts reads them: the five mark colours are the same in both themes.
  const probe = document.createElement('span');
  probe.setAttribute('data-theme', 'light');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;inset:0 auto auto 0';
  document.body.append(probe);
  try {
    const style = getComputedStyle(probe);
    const rgb = (token: string): Rgb => parseColour(style.getPropertyValue(token).trim()) ?? [0, 0, 0];
    const slots: MarkColor[] = [1, 2, 3, 4, 5];
    const bySlot = (suffix: string) => Object.fromEntries(slots.map((s) => [s, rgb(`--sop-mark-${s}${suffix}`)])) as Record<MarkColor, Rgb>;
    return { markRgb: bySlot(''), lineRgb: bySlot('-line'), areaRgb: rgb('--sop-area-outline'), threadRgb: rgb('--sop-thread-underline') };
  } finally {
    probe.remove();
  }
}

/** "#fde293", "#fd2", "rgb(253, 226, 147)" → [253, 226, 147]. */
export function parseColour(v: string): Rgb | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  const fn = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/iu.exec(v);
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : null;
}

/** "paper.pdf" → "paper (with notes).pdf". */
export function withNotesName(displayName: string): string {
  const base = displayName.replace(/\.pdf$/iu, '').trim() || 'document';
  return `${base} (with notes).pdf`;
}

/** The notes this tab would export: live marks and sent threads. False when there is nothing to write. */
export function hasNotes(host: Pick<NotesHost, 'session'>): boolean {
  const s = host.session.state();
  return s.marks.some((m) => m.deletedAt === null) || s.threads.some((t) => t.deletedAt === null && t.draftOfTab === null);
}

type TextAnchor = Extract<Anchor, { kind: 'text' }>;

/**
 * Where an anchor is drawn in these bytes, page by page, 0–1 of the crop box: a text anchor's line rects (made now for
 * the pages that have none, as the mark layer makes them on open), an area's or a figure part's rect, a figure's box.
 */
async function rectsOf(host: NotesHost, a: Anchor): Promise<NormRectsByPage | null> {
  switch (a.kind) {
    case 'text':
      return textRects(host, a);
    case 'area':
      return [{ page: a.page, rects: [a.rect] }];
    case 'figure':
      return [{ page: a.page, rects: [a.sub?.rect ? absoluteRect(a.rect, a.sub.rect) : a.rect] }];
    default:
      return null;
  }
}

async function textRects(host: NotesHost, a: TextAnchor): Promise<NormRectsByPage> {
  const out: NormRectsByPage = [];
  const text = { pageText: host.pageText, pages: host.pages };
  for (let p = a.start.page; p <= a.end.page; p++) {
    const stored = a.rects.find((r) => r.page === p);
    if (stored && stored.rects.length > 0) {
      out.push(stored);
      continue;
    }
    const start = p === a.start.page ? a.start.index : 0;
    const end = p === a.end.page ? a.end.index : (await host.pageText.rawText(p)).length;
    const rects: NormRect[] = end > start ? await markNormRects(text, p, start, end - start) : [];
    if (rects.length > 0) out.push({ page: p, rects });
  }
  return out;
}

/** The page a row's anchor (as placed) is on, for the geometry the plan needs. */
const pagesOf = (a: Anchor): number[] => (a.kind === 'text' ? Array.from({ length: a.end.page - a.start.page + 1 }, (_, k) => a.start.page + k) : a.kind === 'document' ? [0] : [a.page]);

/** The synthetic bold of each bold mark in `plan`, in PDF user space, by the plan item's /NM. */
async function boldFillsOf(host: NotesHost, plan: readonly PdfAnnotationPlan[], geometry: readonly (PageGeometry | undefined)[]): Promise<Record<string, ApFill[]>> {
  const out: Record<string, ApFill[]> = {};
  for (const p of plan) {
    if (p.ap.kind !== 'bold-outlines' || !p.ap.chars) continue;
    const g = geometry[p.pageIndex];
    if (!g) continue;
    // A scan's recognised text has no glyphs in the PDF (its char indices are not PDFium's): its bold mark is written
    // with an empty appearance, as text with no outlines is (R106: the screen and print thicken the scan's ink instead).
    if (host.pageText.source(p.pageIndex).startsWith('ocr:')) continue;
    const { start, count } = p.ap.chars;
    const end = count >= TO_PAGE_END ? (await host.pageText.rawText(p.pageIndex)).length : start + count;
    const from = Math.max(0, start - NEIGHBOUR_CHARS);
    const set = await host.backend.getGlyphShapes(host.doc, p.pageIndex, from, end + NEIGHBOUR_CHARS - from);
    // unrotated page points (y down, from the crop box's top-left) → PDF user space (y up)
    out[p.nm] = boldVectorFills(set, { start, end }).map((f) => ({
      rgb: [f.fill[0], f.fill[1], f.fill[2]],
      path: f.path.map((v, k) => (k % 4 === 1 ? g.crop[0] + v : k % 4 === 2 ? g.crop[3] - v : v)),
    }));
  }
  return out;
}

export interface ExportOptions {
  /** Rows an import made from the file's own annotations, with when (`importContext().refs`). Unchanged ones are not written again: the file holds them. */
  imported?: readonly { rowTable: 'marks' | 'threads' | 'comments'; rowId: string; createdAt: number }[];
  /** The owner's name on their notes (/T); blank leaves it out. Claude's notes say "Claude". */
  authorName: string;
  /** The reading's tags (spec: written into the copy's Keywords), when it is in the library. */
  tags?: readonly string[];
}

/** Writes the notes this tab holds into a copy of the open PDF. Throws when the engine cannot write the copy. */
export async function exportWithNotes(host: NotesHost, o: ExportOptions): Promise<ExportResult> {
  const state = host.session.state();
  const placedAnchor = (id: string): Anchor | null => {
    const r = state.placement.get(id);
    return r?.placed === true ? r.anchor : null;
  };
  // Each row as it is drawn in these bytes: its anchor re-placed for them (so a moved note exports where it is drawn).
  // A row with no placement keeps its stored anchor and is not placed (a mark is left out, a comment goes to its page).
  // Notes that came from the file's own annotations and are unchanged since the import are already in these bytes.
  const importedAt = new Map((o.imported ?? []).map((r) => [r.rowId, r.createdAt]));
  const unchanged = (id: string, changedAt: number): boolean => (importedAt.get(id) ?? -1) >= changedAt;
  const commentsOf = (threadId: string) => state.comments.filter((c) => c.threadId === threadId);
  const marks = state.marks.filter((m) => m.deletedAt === null && !unchanged(m.id, m.updatedAt)).map((m) => ({ ...m, anchor: placedAnchor(m.id) ?? m.anchor }));
  const threads = state.threads
    .filter((t) => t.deletedAt === null && t.draftOfTab === null && !(unchanged(t.id, t.updatedAt) && commentsOf(t.id).every((c) => unchanged(c.id, c.editedAt ?? c.createdAt))))
    .map((t) => ({ ...t, anchor: placedAnchor(t.id) ?? t.anchor }));
  const placedRects = new Map<Anchor, NormRectsByPage | null>();
  const pages = new Set<number>([0]);
  for (const row of [...marks, ...threads]) {
    if (placedAnchor(row.id) === null) {
      placedRects.set(row.anchor, null);
      if (row.pageIndex !== null) pages.add(row.pageIndex);
      continue;
    }
    placedRects.set(row.anchor, await rectsOf(host, row.anchor));
    for (const p of pagesOf(row.anchor)) pages.add(p);
  }
  const geometry: (PageGeometry | undefined)[] = Array.from({ length: host.pages.length }, () => undefined);
  await Promise.all([...pages].filter((p) => p >= 0 && p < host.pages.length).map(async (p) => (geometry[p] = await host.backend.getPageGeometry(host.doc, p))));

  const plan = planPdfExport(
    { marks, threads, comments: state.comments, geometry: geometry as PageGeometry[], place: (a) => placedRects.get(a) ?? null },
    // Replies are threads, drawn empty (D8.1, sample A) until the owner's Foxit and Acrobat check (W-F1).
    { replies: 'threaded', replyAppearance: 'empty', ownerName: o.authorName, ...markColours() },
  );
  const boldFills = await boldFillsOf(host, plan.annotations, geometry);
  // Spec (About this PDF): the reading's context (its document note) goes in the copy's Subject, its tags in Keywords.
  const docNote = threads.find((t) => t.anchor.kind === 'document');
  const docNoteRoot = docNote ? state.comments.filter((c) => c.threadId === docNote.id && c.deletedAt === null && c.draftOfTab === null).sort((a, b) => a.createdAt - b.createdAt)[0] : undefined;
  const info = { ...(docNoteRoot ? { subject: commentPlainText(docNoteRoot) } : {}), ...(o.tags && o.tags.length > 0 ? { keywords: o.tags.join(', ') } : {}) };
  const blob = await host.backend.writeAnnotations(host.opened.loaded.blob, plan.annotations, {
    save: 'tail',
    boldFills,
    ...(host.opened.password !== null ? { password: host.opened.password } : {}),
    ...(Object.keys(info).length > 0 ? { info } : {}),
  });
  return { blob, fileName: withNotesName(host.opened.loaded.displayName), annotations: plan.annotations.length, notPlaced: plan.notPlaced.length, skippedMarks: plan.skippedMarks.length };
}
