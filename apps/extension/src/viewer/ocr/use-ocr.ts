// The scan's reading as the viewer chrome shows it (Phase 7.5): the quiet chip in the header (OcrChip.tsx, in the toolbar pill
// while the menus are hidden) and Find's note while pages are still being read. Both read ViewerOcr.status() (wire.ts).
//
// Wording (plain, short sentences; the owner reads best that way):
//   starting   "Reading text…"                     the page on screen is a scan; the engine loads before the first page
//   reading    "Reading text · 3 of 120 pages"
//   paused     "Reading paused · 3 of 120 pages"
//   done       "Text ready · 120 pages"            once, for a few seconds, and only if this tab saw the reading under way
// The hover says what it is for, and on a PDF that is not saved, that the text is kept in this tab only (D7.1).
// Find: "Still reading pages 21–120. Results may be missing." until every page is read.
import { useEffect, useState } from 'react';
import type { OcrTabStatus, ViewerOcr } from './wire';

/** The "Text ready" chip shows this long, then goes (it fades out over its last moments: OcrChip.module.css). */
export const OCR_DONE_SHOWN_MS = 6000;

export interface OcrChipLook {
  kind: 'starting' | 'reading' | 'paused' | 'done';
  /** The state, which the chip always shows ("Reading text"). */
  label: string;
  /** The count after it (" · 3 of 120 pages"), left out where room is short (the pill, a narrow window). */
  detail?: string;
  /** The hover: what it is, in one to three short sentences. */
  tooltip: string;
  /** How far, 0 to 1; null while there is no count yet (the ring turns). */
  progress: number | null;
  done: number;
  total: number;
  /** The document's page count. */
  pages: number;
  inTabOnly: boolean;
}

/** On a PDF that is not saved (D7.1). */
export const IN_TAB_ONLY = 'This PDF isn’t saved, so its text is kept in this tab only.';
const WHAT_FOR = 'Reading the text on this scan, so you can select, mark and search it.';

const pagesOf = (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`;

/** The chip for a status; null for none. `stage` says whether this tab saw the reading under way, and whether "done" was shown. */
export function chipLook(s: OcrTabStatus, stage: Stage): OcrChipLook | null {
  const tabOnly = s.inTabOnly ? ` ${IN_TAB_ONLY}` : '';
  const first = s.pages > 1 ? ' The page you’re on comes first.' : '';
  const base = { done: s.done, total: s.total, pages: s.pages, inTabOnly: s.inTabOnly };
  const count = s.total > 0 ? ` · ${s.done} of ${pagesOf(s.total)}` : undefined;
  const ratio = s.total > 0 ? Math.min(1, s.done / s.total) : null;
  switch (s.phase) {
    case 'starting':
      return { ...base, kind: 'starting', label: 'Reading text…', tooltip: `${WHAT_FOR}${first}${tabOnly}`, progress: null };
    case 'running':
      if (s.upgrading) {
        return { ...base, kind: 'reading', label: 'Updating text', ...(count !== undefined ? { detail: count } : {}), tooltip: `A newer reader is reading this scan again, to improve its text.${tabOnly}`, progress: ratio };
      }
      // Before the first page is read the count says nothing yet: the ring turns, as while starting.
      if (s.done === 0) return { ...base, kind: 'starting', label: 'Reading text…', tooltip: `${WHAT_FOR}${first}${tabOnly}`, progress: null };
      return { ...base, kind: 'reading', label: 'Reading text', ...(count !== undefined ? { detail: count } : {}), tooltip: `${WHAT_FOR} ${s.done} of ${pagesOf(s.total)} are ready.${tabOnly}`, progress: ratio };
    case 'paused':
      return { ...base, kind: 'paused', label: 'Reading paused', ...(count !== undefined ? { detail: count } : {}), tooltip: `Reading the text on this scan is paused. Click to go on.${tabOnly}`, progress: ratio };
    case 'done':
      return stage === 'done'
        ? { ...base, kind: 'done', label: 'Text ready', ...(s.total > 0 ? { detail: ` · ${pagesOf(s.total)}` } : {}), tooltip: `You can select, mark and search ${s.pages > 1 ? 'every page of this scan' : 'this scan'} now.${tabOnly}`, progress: 1 }
        : null;
    default:
      return null;
  }
}

/** quiet: nothing seen yet. working: the reading was seen under way here. done: "Text ready" is showing. gone: it was shown. */
export type Stage = 'quiet' | 'working' | 'done' | 'gone';

const working = (s: OcrTabStatus) => s.phase === 'starting' || s.phase === 'running' || s.phase === 'paused';

/**
 * The chip's look, followed live. "Text ready" shows once, and only after this tab saw the reading under way (a saved scan read
 * earlier opens with no chip at all); it goes after OCR_DONE_SHOWN_MS.
 */
export function useOcrChip(ocr: ViewerOcr | null): OcrChipLook | null {
  const [look, setLook] = useState<OcrChipLook | null>(null);
  useEffect(() => {
    setLook(null);
    if (ocr === null) return;
    let stage: Stage = 'quiet';
    let timer: ReturnType<typeof setTimeout> | null = null;
    let shown = '';
    const read = () => {
      const s = ocr.status();
      if (working(s)) stage = 'working';
      else if (s.phase === 'done' && stage === 'working') {
        stage = 'done';
        timer = setTimeout(() => {
          stage = 'gone';
          read();
        }, OCR_DONE_SHOWN_MS);
      } else if (s.phase !== 'done' && stage === 'done') stage = 'quiet';
      const next = chipLook(s, stage);
      const key = next === null ? '' : JSON.stringify(next);
      if (key === shown) return;
      shown = key;
      setLook(next);
    };
    read();
    const off = ocr.onStatus(read);
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [ocr]);
  return look;
}

/** "pages 21–120", "page 7", "pages 1–48 and 52–120", or "98 pages" when which ones is not known exactly. */
export function pagesLeft(unread: readonly number[] | null, left: number): string {
  if (unread !== null && unread.length === left && left > 0) {
    const runs: [number, number][] = [];
    for (const i of unread) {
      const last = runs.at(-1);
      if (last !== undefined && i === last[1] + 1) last[1] = i;
      else runs.push([i, i]);
    }
    if (runs.length <= 2) {
      const words = runs.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}–${b + 1}`));
      return `${left === 1 ? 'page' : 'pages'} ${words.join(' and ')}`;
    }
  }
  return pagesOf(left);
}

/** Find's note while the scan is still being read; null once every page is read (or there is no reading). */
export function findNote(s: OcrTabStatus, unread: readonly number[] | null): string | null {
  if (s.phase === 'starting') return 'Still reading this scan. Results may be missing.';
  if (s.phase !== 'running' && s.phase !== 'paused') return null;
  const left = Math.max(0, s.total - s.done);
  if (left === 0) return null;
  const which = pagesLeft(unread, left);
  return s.phase === 'paused' ? `Reading is paused, with ${which} left. Results may be missing.` : `Still reading ${which}. Results may be missing.`;
}

/** What Find reads for its note (find.tsx): the note now, and a callback whenever it may have changed. */
export function findNoteSource(ocr: ViewerOcr): { note(this: void): string | null; subscribe(this: void, cb: () => void): () => void } {
  return { note: () => findNote(ocr.status(), ocr.unread()), subscribe: (cb) => ocr.onStatus(cb) };
}
