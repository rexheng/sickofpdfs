// Ruling R60: a PDF that already has notes opens laid out for its note margin, so the page never moves a moment after
// it appears. The notes come from the library, which connects only after the first page is drawn; so the layout cannot
// wait for them. Instead this tab remembers, on this computer, which saved PDFs had notes the last time they were
// open. The margin's room itself is kept for every PDF whose pages fit with it (R69); what this decides is whether the
// thumbnail rail starts folded, when the margin fits only without it (feature.tsx, foldsRailAtOpen).
//
// What is kept: a short prefix of the file's SHA-256, only for a PDF whose notes are stored in the library (session
// mode 'stored'), never for a PDF that is not saved. It is dropped as soon as the PDF is open with no notes. It lives
// in the extension's own storage, which web pages and content scripts cannot read.
import type { Sha256 } from '@sop/core';

const KEY = 'sop:notes.marginAtOpen';
/** Enough of the hash to tell files apart for this purpose; a wrong guess only costs one re-layout. */
const PREFIX = 16;
/** The most PDFs remembered; the oldest go first. */
const MAX = 500;

function read(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function write(list: string[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    // storage full or blocked: the margin then opens with the first note, as for a new PDF
  }
}

/** Whether this file had notes the last time it was open here. */
export function hadNotes(sha256: Sha256): boolean {
  return read().includes(sha256.slice(0, PREFIX));
}

/** Remembers whether this file has notes now. `has` is only ever true for a PDF saved in the library. */
export function rememberNotes(sha256: Sha256, has: boolean): void {
  const key = sha256.slice(0, PREFIX);
  const list = read();
  const i = list.indexOf(key);
  if (has === (i >= 0)) return;
  if (has) list.push(key);
  else list.splice(i, 1);
  write(list);
}
