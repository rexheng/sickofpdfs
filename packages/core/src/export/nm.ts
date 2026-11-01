// The /NM names of exported annotations (contracts §9) and the other markers an exported file carries.
//
//   sop:<rowId>               a row's annotation on its first page
//   sop:<rowId>~<pageIndex>   the same row's annotation on a later page (a mark that spans pages)
//   sop:<threadId>~popup      the closed pop-up of a thread's root
//
// <rowId> is the row's UUID: the mark's id for a highlight, underline, strikethrough, bold or area; the thread's id for
// a thread's own root (dotted underline, outline square or note icon); the comment's id for a reply. A thread whose root
// is a highlight shares the highlight's /NM, so the thread's id and its first comment's id are not in the file.
// Import mints them again, the same way each time (`derivedId`), so opening the file twice gives the same rows.

/** Every exported /NM starts with this. */
export const NM_PREFIX = 'sop:';

/** /Subj values. 'Bold' and 'Document note' are the contract's; the other two tell import what a /Square or note is. */
export const SUBJ_BOLD = 'Bold';
export const SUBJ_DOCUMENT_NOTE = 'Document note';
export const SUBJ_PAGE_NOTE = 'Page note';
/** A thread's own root (a dotted underline, or the outline square of an area or figure thread), as opposed to a mark that carries a comment. */
export const SUBJ_THREAD = 'Comment';

/** /T of a Claude-written comment (contracts §9: "the owner's name or "Claude""). */
export const CLAUDE_LABEL = 'Claude';

export type NmPart = { kind: 'row' } | { kind: 'page'; pageIndex: number } | { kind: 'popup' };
export interface ParsedNm {
  rowId: string;
  part: NmPart;
}

/** `sop:<rowId>`. */
export const rowNm = (rowId: string): string => `${NM_PREFIX}${rowId}`;

/** The /NM of a row's annotation on `pageIndex`, when the row's first page is `firstPage`. */
export const partNm = (rowId: string, pageIndex: number, firstPage: number): string => (pageIndex === firstPage ? rowNm(rowId) : `${NM_PREFIX}${rowId}~${pageIndex}`);

/** `sop:<threadId>~popup`. */
export const popupNm = (threadId: string): string => `${NM_PREFIX}${threadId}~popup`;

const NM_PATTERN = /^sop:([0-9A-Za-z][0-9A-Za-z-]*)(?:~(\d+)|~(popup))?$/;

/** Reads one of our /NM names; null for anything else (another app's name, a missing name). */
export function parseNm(nm: string | null | undefined): ParsedNm | null {
  if (!nm) return null;
  const m = NM_PATTERN.exec(nm);
  if (!m) return null;
  const rowId = m[1] ?? '';
  if (m[3] === 'popup') return { rowId, part: { kind: 'popup' } };
  if (m[2] !== undefined) return { rowId, part: { kind: 'page', pageIndex: Number(m[2]) } };
  return { rowId, part: { kind: 'row' } };
}

export const isOurNm = (nm: string | null | undefined): boolean => parseNm(nm) !== null;

/** What `pdf_import_refs.pdf_ref` holds for an annotation: its /NM, or `obj:<number>` when it has none. */
export const pdfRefOf = (a: { nm: string | null; objectNumber: number }): string => (a.nm ? a.nm : `obj:${a.objectNumber}`);

/**
 * A UUID-shaped id made from `seed`, the same each time (cyrb128: four 32-bit lanes). Import uses it for rows whose id
 * is not in the file, so reading the same annotations again gives the same rows (Undo then import again, two tabs).
 */
export function derivedId(seed: string): string {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const hex = [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0].map((n) => n.toString(16).padStart(8, '0')).join('');
  // version 4 and the RFC 4122 variant, so it reads as the UUIDv4 every other row id is
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex.slice(16, 17), 16) & 3]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
