// The library save of the open PDF (Task 30): works out whether it is already in the library, asks the filter when it
// is not, and runs the save and forget effects the save machine (@sop/core reduceSave) asks for. It owns the chip's
// state and the 10 s Undo after a first-mark save.
//
// Privacy rules this file keeps:
// - Nothing is written for a PDF the library does not hold until a save: identity only reads (plus an alias of a
//   document that is already saved), and the filter runs in memory.
// - `touchLocation` and `recordOpen` are called here and nowhere else, once, when the PDF turns out to be known. A new
//   document's first location and history row come with `saveDocument` itself.
// - Incognito touches neither the store nor the blob store.
// - Undo (and later "Forget this PDF") deletes every row of the document and its stored copy (R13). A save that fails
//   half-way removes the copy it made, so no copy is left without its document.
// - R67: Undo and Forget also remove what this computer kept of the PDF outside the store (forgetLocalTraces), and every
//   open tab follows a forget back to "Not sure". The first-mark Undo is offered only while that mark is all there is,
//   in any tab; a save a note started has none.
// - Phase 3 (S11): the owner's choice for the file is asked before any page text is read; the filter then runs in memory.
//   "Forget this PDF" removes everything (as Undo does); the store's delete keeps only a salted hash in its forgotten list,
//   so a restore never brings it back (R88, R89), and then the backup writer cleans it out of the backups (R75). A PDF with card or bank numbers that the owner saves
//   anyway keeps its page text out of search (D9).
// - R91: the owner's choices only make the filter more careful. "Never for this file" is read again before any save the owner
//   did not ask for (another tab may have chosen it), covers the reading's id, its downloads and the copy open here, and only
//   the owner's own explicit Save takes it back. When the choices cannot be read, nothing saves on its own.
// - R91: every save reads every page for card, bank or ID numbers before anything is written (the filter only sampled the
//   PDF). An automatic save that finds them stops, and the chip says "Not saved · card or bank numbers"; a save by the
//   owner's click goes on without searchable text, with the warning (D9), however it started.
// - R97: "Never save this file" also keeps a text fingerprint (core's `textFingerprint`, a hash of the first pages' text once
//   stamps and dates are removed), handed to the never-save list, which keeps only a salted HMAC of it, like the file's own
//   fingerprint. So a re-download with other bytes is still "never". The text and the unsalted hash stay in memory.
// - TB4 ruling (Forget wins): when another tab deletes the saved PDF, this controller alone decides what follows. It reads
//   whether that was the owner's Forget (the store's forgotten list, or "never save") before it leaves "saved"; a Forget then
//   reads "Not saved · you removed it" here too, and nothing saves until the owner acts. Only an Undo goes back
//   to "Not sure" (the session then saves again what it holds, R67 tightened 1).
import {
  type DocumentId,
  extractMetadata,
  type FilterDecision,
  type FilterInput,
  guessKind,
  hardBlockDecision,
  hardBlockOnEveryPage,
  type LocationKind,
  type OwnerSavePolicy,
  reduceSave,
  type SaveEffect,
  type SaveEvent,
  type SaveState,
  type Sha256,
  TEXT_FINGERPRINT_PAGES,
  textFingerprint,
} from '@sop/core';
import type { PdfBackend, SaveController } from '@sop/viewer';
import type { BlobStore } from '../../store/blob-store';
import type { StoreChange } from '../../store/change-bus';
import { SAVED_THOUGH_NOT_LEARNING } from '../../store/reading-flags';
import { localDraftJournal } from '../annotations/draft-journal';
import { localPendingSaves, type PendingCause } from '../annotations/save-pending';
import { tabIdentity } from '../annotations/tab-presence';
import { rememberNotes } from '../notes/margin-at-open';
import { forgetLocalTraces } from './local-traces';
import type { StoreClient } from '../../store/client';
import type { FilterReportLabel } from '../../local-only/secrets-store';
import { cannotCheck, FILTER_FAILED, FORGOTTEN_REASON, NEVER_SAVE_REASON, neverSaveDecision } from '../filter/async-filter';
import { type FilterRulesSource, type SiteRule, siteRuleFor } from '../filter/rules-source';
import { buildFilterInput } from '../filter/sample-input';
import { FORGOTTEN_BACKUP_PENDING, FORGOTTEN_LIBRARY_ONLY, type ForgetBackupResult } from '../../backup/forget';
import { type IdentityResult, resolveIdentity } from '../identity/resolve-identity';
import type { OpenedDocument } from '../open-document';
import { requestCloudForget } from '../../shared/cloud-messages';

/** What the viewer calls a PDF whose address gives no name (displayNameFor's fallback). Never a title. */
const GENERIC_NAME = 'document.pdf';

/** How long "Undo" stays next to the chip after a first mark saved the PDF. */
export const UNDO_MS = 10_000;
/** Pages of text per `putPageText` call. */
export const PAGE_TEXT_BATCH = 50;

/** Tooltips of the "Saved to library" chip after a save in this tab (an automatic save shows the filter's reasons). */
export const SAVED_BY_OWNER = 'You saved it';
export const SAVED_BY_FIRST_MARK = 'Your first mark saved it';
export const SAVED_BY_FIRST_NOTE = 'Your first note saved it';
/**
 * R105b: a save that a tab which closed or crashed had started, finished on the next open, whose record does not say what started
 * it (or says the filter did, which saves on its own if it still judges the PDF learning). Never the owner's own choice.
 */
export const SAVED_WHEN_REOPENED = 'Your notes saved it';

/** R67 (c): the channel on which a tab tells the others that a PDF has more than its first mark now. */
export const SAVE_CHANNEL = 'sop-save';
interface MoreContent {
  type: 'more-content';
  /** The file's fingerprint and, once saved, its library id. */
  ids: string[];
  /**
   * R67 tightened (1): the sender is still working out which PDF it is ("checking"), so it may turn out to be a stamped copy
   * of the receiver's document. A copy always has the same page count (R59 a), so a receiver with that count counts it.
   */
  checking?: boolean;
  pageCount?: number;
  /**
   * N1 (re-check of R67): false for an empty note box, which ends a first-mark Undo but is not content: it does not stop
   * an erased note's save from being taken back. A message without it counts as content.
   */
  content?: boolean;
}
/** R91: a tab kept "Never save this file" for these fingerprints; the other tabs read the choice again at once. */
interface NeverSaveNews {
  type: 'never-save';
  ids: string[];
}

/**
 * D9 (R91): the warning of a save whose text could not be checked for card or bank numbers. Its text is kept out of search,
 * as for a PDF that has them.
 */
export const UNCHECKED_WARNING = 'This PDF couldn’t be checked for card or bank numbers, so its text is not searchable.';


export interface SaveLocation {
  kind: LocationKind;
  raw: string;
  /** The course or web page the PDF was opened from. */
  viaPage: string | null;
  /** The title of that page (R92c), for the categoriser's course codes. Stays on this computer. */
  viaTitle?: string | null;
}

export interface SaveControllerDeps {
  opened: OpenedDocument;
  backend: PdfBackend;
  /**
   * Null in Incognito, or when the library could not be reached. It may be given while it still connects (a promise),
   * so the controller exists as soon as the PDF is open; `start()` waits for it, in the `checking` state.
   */
  store: StoreClient | null | Promise<StoreClient | null>;
  /** Null in Incognito; without it a save keeps no copy of the PDF (`blobStored: false`). May be a promise too. */
  blobs: BlobStore | null | Promise<BlobStore | null>;
  /** The learning filter (contracts §5): Phase 3's async filter (async-filter.ts), or the stand-in. */
  filter: (i: FilterInput) => FilterDecision | Promise<FilterDecision>;
  /**
   * Phase 3: the owner's choice for this exact file ("Never save this file"), asked before any page text is read. A
   * decision ends the filter there; null goes on to the sample and `filter`. Left out: no choice.
   */
  fileChoice?: () => Promise<FilterDecision | null>;
  /** Phase 3: the owner's rules and the records the filter keeps on this computer. Null in Incognito and for an upload. */
  rules?: FilterRulesSource | null;
  /** R75: takes a forgotten document out of every backup snapshot (S13's `forgetFromBackups`). Left out: there are no backups. */
  scrubBackups?: (documentId: DocumentId) => Promise<ForgetBackupResult>;
  incognito: boolean;
  /** Where the PDF was opened from; null for a file picked from disk. */
  location: SaveLocation | null;
  /**
   * R103: the PDF was made from a web page ("Save this page to library"). Its title, authors and year are the page's, not read
   * from the PDF, it gets no DOI or arXiv id (so nothing is looked up online for it), and `reasons` (the web page's flags,
   * store/reading-flags.ts) are saved with it.
   */
  madeFrom?: { title: string; authors: string[]; year: number | null; reasons: string[] };
  now(): number;
}

/** What the viewer's chrome reads beyond the shared SaveController contract. */
export interface SaveControllerImpl extends SaveController {
  /** The effect running now: the chip reads "Saving…", and Undo waits. Changes are announced through `subscribe`. */
  readonly busy: 'save' | 'forget' | null;
  /** The reasons a save in this tab stored, for the chip's tooltip; null when the PDF was already in the library. */
  readonly savedReasons: readonly string[] | null;
  /** R67 (a): the last save failed and nothing has saved the PDF since. The chip says "Couldn't save. Try again". */
  readonly failed: boolean;
  /** R67 tightened (4): a save left by a tab that closed or crashed is being finished. The chip says "Saving your notes…". */
  readonly resuming: boolean;
  /** The library document, while the state is `saved`. */
  documentId(): DocumentId | null;
  /**
   * D9: the saved PDF's text is kept out of search (it has card, bank or ID numbers, or could not be checked for them), saved
   * here or before. The chip says "Saved · text not searchable". Changes are announced through `subscribe`.
   */
  readonly notSearchable: boolean;
  /**
   * The saved document is in the library's Trash (ruling R76): the chip says "In Trash" and offers Restore. Opening it
   * never restores it by itself. Changes are announced through `subscribe`.
   */
  readonly trashed: boolean;
  /** Takes the saved document out of the Trash. Rejects when the library could not do it. */
  restoreFromTrash(): Promise<void>;
  /** TB5: the chip's "Move to Trash", as the library's: the document goes to the Trash (kept 30 days). Rejects when it could not. */
  moveToTrash(): Promise<void>;
  /** `cb` hears of a save or forget that failed. The state is then what it was before; the call also rejects. */
  onFailure(cb: (what: 'save' | 'forget') => void): () => void;
  /** Phase 3: the filter's decision in this tab; null while checking, or when the PDF was in the library already. */
  readonly decision: FilterDecision | null;
  /**
   * D9: the warning line of a save by choice of a PDF with card, bank or ID numbers (its text is not searchable); null
   * otherwise. Set when such a save in this tab is done. Changes are announced through `subscribe`.
   */
  readonly saveWarning: string | null;
  /** "Always for this site": the allow-list entry this PDF's link gives; null for a file picked from disk. */
  readonly siteRule: SiteRule | null;
  /** Why the PDF is not saved: the first reason behind its "Not saved · …" chip. Kept while the question is open. */
  readonly whyNotSaved: string | null;
  /** The PDF is not saved because the owner chose "Never save this file" (TB5: notes held then are kept privately). */
  readonly neverChosen: boolean;
  /** True when the owner's rules can be changed here ("Never for this file", "Always for this site", reports). */
  readonly hasRules: boolean;
  /** "Never for this file": remembered as a salted fingerprint; the chip then says so, and a mark asks before saving. */
  neverSave(): Promise<void>;
  /** "Always for this site": the site (or folder) goes on the allow list, and this PDF is saved. */
  alwaysForSite(): Promise<void>;
  /**
   * "Forget this PDF" and "Remove from library…": the library, this computer and the backups keep nothing of it (R13,
   * R75); the store's forgotten list (a salted hash, R88, R89) stops a restore from bringing it back. `neverSave` also
   * remembers "Never save this file".
   * Rejects (and changes nothing) when it is not saved, or the library could not forget it.
   */
  forget(o: { neverSave: boolean }): Promise<ForgetOutcome>;
  /** "Report a wrong decision": the owner's label and a salted fingerprint, kept on this computer only. */
  report(label: FilterReportLabel): Promise<void>;
  /** What the saved PDF holds, for the Forget question: live marks, and notes (threads with text). Zeros when not saved. */
  contents(): Promise<{ marks: number; notes: number }>;
  /** Stops the Undo timer and the listeners. */
  dispose(): void;
}

/** What a Forget did besides removing the PDF: the backups, and the "Never save this file" choice. */
export interface ForgetOutcome {
  /** S13's answer: removed from the backups too, waiting for the folder, or no backup folder; with the words to show. */
  backups: ForgetBackupResult;
  neverSave: 'kept' | 'failed' | 'not-asked';
}

/** How long Forget waits for the backups to be cleaned before it says the next backup will finish the job. */
export const SCRUB_WAIT_MS = 60_000;

/** Why a save runs. Only 'owner' is the owner's own explicit Save (the chip, Ctrl+Alt+S, the banner, Save in the question). */
type SaveCause = 'filter' | 'owner' | 'first-mark' | 'first-note' | 'resume';

/**
 * The save reason a save stores. R105b: a resumed save keeps the reason of the save its tab started (`resumed`, from its record), so
 * a first note's save finished after a crash is still a first note's save; when the record does not say, it is not the owner's.
 */
function reasonOf(cause: Exclude<SaveCause, 'filter'>, resumed: PendingCause | null): string {
  const c = cause === 'resume' ? resumed : cause;
  return c === 'owner' ? SAVED_BY_OWNER : c === 'first-note' ? SAVED_BY_FIRST_NOTE : c === 'first-mark' ? SAVED_BY_FIRST_MARK : SAVED_WHEN_REOPENED;
}

/** The saved chip's hover lists this many reasons at most, strongest first. */
export const SAVED_REASONS = 4;

/**
 * Why the filter saved it, for the hover and the library: up to 4 reasons, strongest first, in the owner's words ("arXiv
 * number, Many citations, Abstract"). A save by the score (or by the tie-breaker's nudge) names its strongest signals; a save
 * by a rule (force save, the allow list) keeps the rule's own words first.
 */
export function filterReasons(d: FilterDecision | null): string[] {
  if (d === null) return [];
  if ((d.rule === 'score' || d.rule === 'model') && d.signals !== undefined) {
    const out: string[] = [];
    for (const s of [...d.signals].filter((x) => x.weight > 0).sort((a, b) => b.weight - a.weight)) {
      if (!out.includes(s.label)) out.push(s.label);
      if (out.length === SAVED_REASONS) break;
    }
    if (out.length > 0) return out;
  }
  return d.reasons.slice(0, SAVED_REASONS);
}

/** A forget the owner asked for (Forget this PDF), as opposed to an Undo or a withdrawn first note. */
interface OwnerForget {
  neverSave: boolean;
  /** Filled in once the PDF is forgotten. */
  done?: { documentId: DocumentId; neverSave: ForgetOutcome['neverSave'] };
}

export function createSaveController(d: SaveControllerDeps): SaveControllerImpl {
  const { loaded, open } = d.opened;
  const openedAt = d.now();
  const listeners = new Set<(s: SaveState) => void>();
  const failureListeners = new Set<(what: 'save' | 'forget') => void>();
  let state: SaveState = { kind: 'checking' };
  let busy: { kind: 'save' | 'forget'; done: Promise<void> } | null = null;
  let decision: FilterDecision | null = null;
  let savedReasons: readonly string[] | null = null;
  /** The owner reported this PDF as a learning one ("It's for learning"): saving it is not saving it against the filter (R102). */
  let reportedLearning = false;
  /** D9: the warning of the save by choice this tab made of a hard-blocked PDF. */
  let saveWarning: string | null = null;
  /** The first reason of the last "not learning" state, for the question a mark then asks. */
  let whyNotSaved: string | null = null;
  const siteRule = siteRuleFor(loaded.sourceUrl ?? d.location?.raw ?? null);
  let started: Promise<void> | null = null;
  let undoTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let trashed = false;
  /** D9: the saved document's row says its text is kept out of search (`indexText: false`). */
  let rowNotIndexed = false;
  /** The store and blob store, once `start()` has them. Effects only run after that. */
  let store: StoreClient | null = null;
  let blobs: BlobStore | null = null;
  /** Stops listening to the library's changes (another tab's save). */
  let stopFollowing: (() => void) | null = null;
  /** R67 (a): the last save failed. */
  let failed = false;
  /** R67 tightened (4): a save the owner started in a tab that went is being finished: "Saving your notes…". */
  let resuming = false;
  /** R105b: what started the save being resumed, as its tab's record says; null when it does not say. */
  let resumedCause: PendingCause | null = null;
  /** R105b: what started the save running now, for the session's save-pending record. */
  let savingCause: PendingCause | null = null;
  /** N1: a note box opened (here or in another tab) while the save that is running now was on its way: it lands with no Undo. */
  let boxDuringSave = false;
  /** R67 tightened (3): a note started a save here since the PDF was last forgotten; no later save gets an Undo. */
  let noteSeen = false;
  /** R67 tightened (1): how many mark rows the last first mark made; Undo may remove no more than these. */
  let triggerRows: number | null = null;
  /** R67 (c): since the last first mark here, more was made here (another mark, a note): its save gets no Undo. */
  let moreHere = false;
  /** R67 (f): the last first-mark save here was asked for by a note. */
  let byNote = false;
  /** R67 (c): another tab said it has more on this PDF; a save here gets no Undo until the PDF is forgotten. */
  let othersAdded = false;
  /** R67 (b): this tab's last save created the document (not another tab's, not one already there). */
  let createdHere = false;
  /**
   * R67 (c): tells the other tabs; null in Incognito or where there is no BroadcastChannel. Open from the start, so content
   * made while the PDF is still being identified is told too (R67 tightened 1).
   */
  let channel: BroadcastChannel | null = null;
  if (!d.incognito && typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(SAVE_CHANNEL);
      channel.onmessage = onMoreContent;
    } catch {
      channel = null;
    }
  }

  const notify = (): void => {
    for (const cb of [...listeners]) {
      try {
        cb(state);
      } catch {
        // One listener's failure must not stop the others.
      }
    }
  };

  const stopUndoTimer = (): void => {
    if (undoTimer !== null) clearTimeout(undoTimer);
    undoTimer = null;
  };

  const startUndoTimer = (): void => {
    stopUndoTimer();
    undoTimer = setTimeout(() => {
      undoTimer = null;
      void dispatch({ type: 'undo-expired' });
    }, UNDO_MS);
  };

  function set(next: SaveState): void {
    const wasUndoable = state.kind === 'saved' && state.undoable;
    const undoable = next.kind === 'saved' && next.undoable;
    if (next === state) return;
    state = next;
    if (next.kind === 'saved') failed = false;
    if (next.kind === 'saved' || next.kind === 'memory-only') resuming = false; // saved, or the owner said No
    if (next.kind === 'not-learning') whyNotSaved = next.reasons[0] ?? null;
    else if (next.kind !== 'asking' && next.kind !== 'memory-only') whyNotSaved = null;
    if (undoable && !wasUndoable) startUndoTimer();
    if (!undoable) stopUndoTimer();
    if (next.kind !== 'saved') {
      savedReasons = null;
      saveWarning = null;
      trashed = false; // a PDF that is not in the library is not in its Trash either
      rowNotIndexed = false;
    }
    notify();
  }

  // ---- page text: read once, page by page, so page renders can go between the engine calls ----
  const texts = new Map<number, Promise<string>>();
  const textOf = (pageIndex: number): Promise<string> => {
    const hit = texts.get(pageIndex);
    if (hit) return hit;
    const p = d.backend.getPageText(open.doc, pageIndex);
    texts.set(pageIndex, p);
    p.catch(() => {
      if (texts.get(pageIndex) === p) texts.delete(pageIndex); // a failed read may be asked again
    });
    return p;
  };
  async function textsOf(indexes: number[]): Promise<string[]> {
    const out: string[] = [];
    for (const i of indexes) out.push(await textOf(i));
    return out;
  }
  const allPageTexts = (): Promise<string[]> => textsOf(Array.from({ length: open.pageCount }, (_, i) => i));

  /**
   * R97: this PDF's text fingerprint, read once (the filter has read these pages already); null when it has too little
   * text. It lives in memory only: the never-save list keeps a salted HMAC of it. A failed read is tried again next time.
   */
  let textKeyRead: Promise<Sha256 | null> | null = null;
  function textKey(): Promise<Sha256 | null> {
    if (textKeyRead !== null) return textKeyRead;
    const read = textsOf(Array.from({ length: Math.min(open.pageCount, TEXT_FINGERPRINT_PAGES) }, (_, i) => i)).then((pages) =>
      textFingerprint(open.pageCount, pages),
    );
    textKeyRead = read.catch(() => {
      textKeyRead = null;
      return null;
    });
    return textKeyRead;
  }
  /** The fingerprints the owner's choice for this file is kept under: the file's own, and its text's (R97). */
  async function choiceKeys(...more: Sha256[]): Promise<Sha256[]> {
    const key = await textKey();
    return [...new Set([...more, loaded.sha256, ...(key === null ? [] : [key])])];
  }

  /**
   * The filter's view of the PDF (S8's `buildFilterInput`): links, names, sizes, metadata, form type and the text of the
   * first and last 5 pages (and of up to 10 middle pages when those hold almost no words). It reads through this tab's
   * page-text cache, so a save afterwards does not read those pages again. Text the engine cannot read counts as no text.
   */
  function filterInput(): Promise<FilterInput> {
    return buildFilterInput(d.backend, open, {
      url: loaded.sourceUrl ?? d.location?.raw ?? null,
      fileName: loaded.displayName,
      viaPage: d.location?.viaPage ?? null,
      pageText: textOf,
    });
  }

  /**
   * Title, authors, year, DOI, arXiv id and kind for the library (S4's `extractMetadata` and `guessKind`): the Info fields
   * unless they are junk, then page 1, then the link and the file name. A PDF saved by choice that is not a reading
   * (`private`: card or bank numbers, or judged not learning) is named from its Info title and file name only.
   */
  function metadataToSave(pages: readonly string[], private_: boolean) {
    const first = private_ ? '' : (pages[0] ?? '');
    const m = extractMetadata({
      fileName: loaded.displayName,
      url: loaded.sourceUrl ?? d.location?.raw ?? null,
      metadata: open.metadata,
      firstPageText: first,
      secondPageText: private_ ? '' : (pages[1] ?? ''),
      now: d.now(),
    });
    const kind = guessKind({ pageCount: open.pageCount, pageSizes: open.pages, firstPageText: first });
    return { ...m, title: m.title ?? pickedFileTitle(), kind };
  }

  /**
   * A file picked from disk with no title is saved under its file name (ruling R76), since it has no link the library
   * could name it by; a PDF from the web without one is named by its link.
   */
  function pickedFileTitle(): string | null {
    if (d.location !== null || loaded.displayName === GENERIC_NAME) return null;
    const name = loaded.displayName.replace(/\.pdf$/i, '').trim();
    return /[\p{L}\p{N}]/u.test(name) ? name : null;
  }

  // ---- effects ----
  async function saveEffect(undoable: boolean, cause: SaveCause): Promise<void> {
    if (store === null) throw new Error('library-unavailable: the library could not be opened in this tab');
    const id = loaded.sha256;
    const pages = await allPageTexts();
    // D9: card, bank or ID numbers. The owner's own save wins, with a warning, and the text is kept out of search. R91: every
    // page is read for them now, before anything is written, however the save started. A save the owner did not click for
    // (the filter's own, a first mark, a resumed one) stops instead: the PDF is "not learning", and a mark asks.
    let owner = decision?.ownerSave ?? null;
    if (owner === null) {
      const found = await blockOnEveryPage(pages);
      if (found !== null && cause !== 'owner') {
        held = { cause, decision: found.decision };
        return;
      }
      owner = found?.ownerSave ?? null;
    }
    const put = blobs === null ? null : await blobs.put(loaded.blob, id);
    const reasons = cause === 'filter' ? filterReasons(decision) : [reasonOf(cause, resumedCause)];
    // Page 1 names a reading; paperwork saved by choice (a receipt, a never-save file) keeps its own name instead, which is
    // both the better name for it and keeps the words of a private page out of the library's title.
    const read = metadataToSave(pages, owner !== null || decision?.verdict === 'not-learning');
    const made = d.madeFrom;
    const meta = made === undefined ? read : { ...read, title: made.title, authors: made.authors, year: made.year, doi: null, arxivId: null, kind: 'other' as const };
    const madeReasons = made?.reasons ?? [];
    let created: boolean;
    try {
      ({ created } = await store.saveDocument({
        id,
        byteSize: loaded.size,
        pageCount: open.pageCount,
        title: meta.title,
        authors: meta.authors,
        year: meta.year,
        doi: meta.doi,
        arxivId: meta.arxivId,
        kind: meta.kind,
        ...(owner !== null ? { indexText: owner.indexText } : {}),
        pdfId: open.metadata.pdfId,
        hasText: pages.some((t) => /\S/u.test(t)),
        encrypted: open.encrypted,
        blobStored: put !== null,
        // R102 (Nov 6 ruling): the filter judged it not learning and the owner saved it anyway (a receipt, a statement, a CV kept
        // on purpose). It stays searchable unless D9 applies, but is never understood: no related readings, topics or auto tags.
        // The flag is a save reason, so it is written in the same transaction and goes with the reading into backups and sync.
        saveReasons: [...(decision?.verdict === 'not-learning' && !reportedLearning ? [...reasons, SAVED_THOUGH_NOT_LEARNING] : reasons), ...madeReasons],
        location: d.location,
        openedAt,
      }));
    } catch (error) {
      if (put?.created === true) await dropCopyWithoutDocument(store, blobs, id);
      throw error;
    }
    try {
      for (let at = 0; at < pages.length; at += PAGE_TEXT_BATCH) {
        await store.putPageText(
          id,
          pages.slice(at, at + PAGE_TEXT_BATCH).map((text, k) => ({ pageIndex: at + k, text })),
        );
      }
    } catch (error) {
      // The document is saved; only search misses some of its pages. Nothing about the PDF goes in the message.
      console.warn('sickofpdfs: the page text was not all stored', error instanceof Error ? error.message.split(':')[0] : '');
    }
    texts.clear(); // the library has the text now; this tab no longer needs its copy
    savedReasons = reasons;
    saveWarning = owner?.warning ?? null;
    // R91: only the owner's own explicit Save takes "never save" back. (In the store's list a saved PDF does not count as
    // forgotten, R89.)
    if (cause === 'owner' && d.rules) {
      const rules = d.rules;
      void choiceKeys(id)
        .then((keys) => rules.saved(keys))
        .catch(() => {});
    }
    createdHere = created && (cause === 'first-mark' || cause === 'first-note');
    // R67 (c): Undo only ever removes the save and the one mark that caused it. Not when this tab did not create the
    // document, nor when more was made meanwhile, here or in another tab.
    await dispatch({ type: 'saved', documentId: id, undoable: undoable && created && !moreHere && !othersAdded && !boxDuringSave });
  }

  /**
   * R91: the hard-block check over every page at save time: the D9 policy, and the decision a save that is not the owner's
   * own stops with; null when the PDF has no blocking numbers. Positive evidence of 8 or more in the filter's own sample
   * overrides a block, as in `classify` (the pages are in this tab's cache already). If it cannot be checked, the text is
   * kept out of search too, and a save the owner did not click for stops.
   */
  async function blockOnEveryPage(pages: readonly string[]): Promise<{ ownerSave: OwnerSavePolicy; decision: FilterDecision } | null> {
    try {
      const input = await filterInput().catch(() => null);
      const found = hardBlockOnEveryPage(input, pages);
      return found === null ? null : { ownerSave: found.ownerSave, decision: hardBlockDecision(found) };
    } catch {
      return { ownerSave: { warning: UNCHECKED_WARNING, indexText: false }, decision: cannotCheck(decision, FILTER_FAILED) };
    }
  }

  /**
   * R91: a save the owner did not click for found card, bank or ID numbers on a page the filter had not read, and stopped
   * before writing anything. Once its effect has ended, the PDF is "not learning" with those reasons; a first mark (or a
   * resumed save) that started it asks "Save this PDF to keep your notes?" instead.
   */
  let held: { cause: SaveCause; decision: FilterDecision } | null = null;
  function settleHeld(): void {
    const h = held;
    held = null;
    if (h === null || disposed) return;
    decision = h.decision;
    if (state.kind === 'checking') {
      void dispatch({ type: 'classified', decision: h.decision });
      return;
    }
    if (state.kind !== 'unsure') return;
    void dispatch({ type: 'never-save', reasons: [...h.decision.reasons] });
    if (h.cause === 'first-mark' || h.cause === 'first-note') void dispatch({ type: 'first-mark' });
    else if (h.cause === 'resume') void dispatch({ type: 'resume-save' });
  }

  /** The copy this tab stored, when the document did not get saved after all (another tab may have saved it). */
  async function dropCopyWithoutDocument(lib: StoreClient, copies: BlobStore | null, id: DocumentId): Promise<void> {
    const there = await lib.getDocument(id).then(
      (row) => row !== null,
      () => false,
    );
    if (!there) await copies?.delete(id).catch(() => {});
  }

  /**
   * Removes the saved PDF: its rows, its copy, and what this computer kept outside the store. `owner` is the owner's own
   * Forget: the store's delete writes its forgotten list in the same transaction (R88, R89), so another tab that hears the
   * delete can tell a Forget from an Undo; the chip says "removed from your library", and the backups are cleaned (R75).
   * Without it (Undo, a withdrawn first note) the PDF goes back to "not sure" and nothing at all is kept.
   */
  async function forgetEffect(owner: OwnerForget | null): Promise<void> {
    if (store === null || state.kind !== 'saved') return;
    const id = state.documentId;
    let neverKept: ForgetOutcome['neverSave'] = 'not-asked';
    let neverKeys: Sha256[] = [];
    // "Never save this file" is kept before the delete, so another tab that hears of the delete already reads it. R91: it covers
    // the reading's id, every download of it (its aliases) and the copy open here. If the downloads cannot be listed, nothing
    // is changed and the Forget fails, so the owner can try again.
    if (owner !== null && owner.neverSave) {
      neverKept = 'failed';
      if (d.rules) {
        neverKeys = await choiceKeys(id, ...(await store.listAliases(id))); // R97: and the text fingerprint
        neverKept = await d.rules.neverSave(neverKeys).then(() => 'kept' as const, () => 'failed' as const);
      }
    }
    try {
      // R88, R89: the owner's Forget is a delete for good, which the store writes to its forgotten list in the same transaction;
      // an Undo of a save (or a withdrawn first note) is not, and writes nothing (`undo: true`).
      await store.forgetDocument(id, owner === null ? { undo: true } : undefined);
    } catch (error) {
      // Still saved: the choice just kept for it goes again.
      if (neverKept === 'kept') await d.rules?.saved(neverKeys).catch(() => {});
      throw error;
    }
    if (neverKept === 'kept') tellNever(neverKeys);
    // D2, CA8: the cloud forgets it too (queued until it is sent; nothing at all when no server is connected). An Undo of a
    // save goes too: a save the owner took back must not stay in the cloud. A new save later syncs again.
    void requestCloudForget(id);
    // R67 (e): the drafts' crash-safe copies, the save-pending records and the margin hint go with the document.
    forgetLocalTraces(id, loaded.sha256);
    await blobs?.delete(id);
    if (owner === null) {
      backToNotSure();
      return;
    }
    othersAdded = false;
    moreHere = false;
    byNote = false;
    noteSeen = false;
    createdHere = false;
    triggerRows = null;
    rememberNotes(loaded.sha256, false); // R67 tightened (6), as backToNotSure does
    if (owner.neverSave && neverKept === 'kept') decision = neverSaveDecision();
    set(reduceSave(state, { type: 'forgotten', reasons: [owner.neverSave && neverKept === 'kept' ? NEVER_SAVE_REASON : FORGOTTEN_REASON] }).state);
    owner.done = { documentId: id, neverSave: neverKept };
  }

  /** R75: the backup writer takes the document out of every snapshot. A wait that ends says the next backup finishes it. */
  async function scrub(id: DocumentId): Promise<ForgetBackupResult> {
    if (d.scrubBackups === undefined) return { status: 'no-backup', message: FORGOTTEN_LIBRARY_ONLY };
    const pending: ForgetBackupResult = { status: 'pending', message: FORGOTTEN_BACKUP_PENDING };
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const late = new Promise<ForgetBackupResult>((resolve) => {
        timer = setTimeout(() => resolve(pending), SCRUB_WAIT_MS);
      });
      return await Promise.race([d.scrubBackups(id), late]);
    } catch {
      return pending;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /** After a forget, here or in another tab (R67 d): "Not sure" again, and the next first mark starts afresh. */
  function backToNotSure(): void {
    othersAdded = false;
    moreHere = false;
    byNote = false;
    noteSeen = false;
    createdHere = false;
    triggerRows = null;
    // R67 tightened (6): this tab's own file (a second download, say) leaves no margin hint once it is not saved.
    rememberNotes(loaded.sha256, false);
    // The filter's own reasons are the right tooltip; a PDF that was in the library when it opened has none.
    set(reduceSave(state, { type: 'undone', reasons: decision?.verdict === 'unsure' ? decision.reasons : [] }).state);
  }

  /**
   * What another tab's delete of the saved PDF was: the owner's Forget ('never' when "Never save this file" came with it) or
   * an Undo of a save. Read before this tab leaves "saved" (TB4 ruling, Forget wins): "never save" is kept before the delete,
   * and the store's forgotten list in the same transaction as it (R88, R89; an Undo writes nothing to it). When either cannot
   * be read, it counts as a Forget, so nothing saves on its own (R91). Without the owner's rules here it is an Undo, as before.
   */
  async function deleteKind(lib: StoreClient, documentId: DocumentId): Promise<'never' | 'forget' | 'undo'> {
    const rules = d.rules;
    if (!rules) return 'undo';
    const keys = await choiceKeys(documentId).catch(() => [loaded.sha256, documentId]);
    const never = await rules.fileChoice(keys).catch(() => 'unknown' as const);
    if (never === 'never') return 'never';
    const forgotten = await lib.forgottenAmong([documentId, loaded.sha256]).then(
      (ids) => ids.length > 0,
      () => true,
    );
    return forgotten || never === 'unknown' ? 'forget' : 'undo';
  }

  /** How long this tab waits to learn what another tab's delete was before it treats it as the owner's Forget. */
  const DELETE_READ_MS = 5_000;

  /**
   * R67 (d) and the TB4 ruling: another tab deleted the saved PDF. This tab stays "saved" (the session has stopped writing,
   * session.ts `suspectDocGone`) until it knows which delete it was, then follows in one step: an Undo goes back to "Not sure",
   * the owner's Forget to "Not saved · you removed it" (or "Not saved · your choice"), where a mark asks.
   * Nothing is saved again on its own after a Forget.
   */
  let followingDelete: DocumentId | null = null;
  async function followDelete(lib: StoreClient, documentId: DocumentId): Promise<void> {
    if (followingDelete === documentId) return;
    followingDelete = documentId;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const late = new Promise<'forget'>((resolve) => {
        timer = setTimeout(() => resolve('forget'), DELETE_READ_MS);
      });
      const kind = await Promise.race([deleteKind(lib, documentId), late]);
      if (disposed || busy !== null || state.kind !== 'saved' || state.documentId !== documentId) return;
      if (kind === 'undo') {
        backToNotSure();
        return;
      }
      othersAdded = false;
      moreHere = false;
      byNote = false;
      noteSeen = false;
      createdHere = false;
      triggerRows = null;
      rememberNotes(loaded.sha256, false); // R67 tightened (6), as backToNotSure does
      if (kind === 'never') decision = neverSaveDecision();
      set(reduceSave(state, { type: 'forgotten', reasons: [kind === 'never' ? NEVER_SAVE_REASON : FORGOTTEN_REASON] }).state);
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (followingDelete === documentId) followingDelete = null;
    }
  }

  /** An open, empty note box (N1): the first-mark Undo chip goes (or the save on its way lands without one), and nothing else changes. */
  function expireUndo(): void {
    if (busy?.kind === 'save') boxDuringSave = true;
    if (state.kind === 'saved' && state.undoable) void dispatch({ type: 'undo-expired' });
  }

  /** R67 (c): no Undo for what is saved here, or for the save on its way. */
  function endUndoHere(): void {
    moreHere = true;
    if (state.kind === 'saved' && state.undoable) void dispatch({ type: 'undo-expired' });
  }

  function tellOthers(content: boolean): void {
    try {
      const msg: MoreContent = {
        type: 'more-content',
        ids: [loaded.sha256, ...(state.kind === 'saved' ? [state.documentId] : [])],
        checking: state.kind === 'checking',
        pageCount: open.pageCount,
        content,
      };
      channel?.postMessage(msg);
    } catch {
      // the other tabs keep their Undo a little longer; it still runs out after 10 s
    }
  }

  /** R91: tells the other tabs that "Never save this file" was kept, so they read it again now, not only at their next mark. */
  function tellNever(ids: string[]): void {
    try {
      const msg: NeverSaveNews = { type: 'never-save', ids };
      channel?.postMessage(msg);
    } catch {
      // each tab still reads the choice again before a first mark saves
    }
  }

  function onMoreContent(e: MessageEvent): void {
    const news = e.data as Partial<NeverSaveNews> | null;
    if (!disposed && news?.type === 'never-save' && Array.isArray(news.ids)) {
      const ids = news.ids;
      if (ids.includes(loaded.sha256)) void holdForChoice();
      // R97: another download of the same text (its text fingerprint is in the news)
      else if (state.kind === 'unsure') void textKey().then((k) => (k !== null && ids.includes(k) ? holdForChoice() : undefined));
      return;
    }
    const m = e.data as Partial<MoreContent> | null;
    if (disposed || !m || m.type !== 'more-content' || !Array.isArray(m.ids)) return;
    const mine =
      m.ids.includes(loaded.sha256) || (state.kind === 'saved' && m.ids.includes(state.documentId)) || (m.checking === true && m.pageCount === open.pageCount);
    if (!mine) return;
    if (m.content === false) return expireUndo(); // an empty note box in another tab (N1)
    othersAdded = true;
    endUndoHere();
  }

  /**
   * R67 tightened (1): Undo removes the save and the one mark that made it, and never anything another tab or another
   * download added. Checked again when Undo is pressed: no other tab said it has content, no closed tab left a
   * save-pending record for this PDF, and the library holds no note and no more marks than that first mark made.
   */
  async function onlyTheFirstMark(lib: StoreClient, documentId: DocumentId): Promise<boolean> {
    if (othersAdded) return false;
    const me = tabIdentity()?.tabId ?? null;
    const pending = localPendingSaves();
    for (const key of new Set<string>([loaded.sha256, documentId])) {
      if ((pending?.list(key) ?? []).some((r) => r.tab !== me)) return false;
    }
    try {
      const held = await lib.listAnnotations(documentId);
      if (held.threads.length > 0 || held.comments.length > 0) return false;
      if (triggerRows !== null && held.marks.length > triggerRows) return false;
    } catch {
      return false; // when in doubt, keep everything
    }
    return !othersAdded;
  }

  /** R91: the owner's choice for this file, read now: 'unknown' when it cannot be read. */
  async function choiceNow(): Promise<'never' | 'unknown' | null> {
    const rules = d.rules;
    if (!rules) return null;
    // R97: under the file's own fingerprint, or its text's (another download of the same PDF)
    const keys = await choiceKeys().catch(() => [loaded.sha256]);
    return rules.fileChoice(keys).then(
      (c) => c,
      () => 'unknown' as const,
    );
  }

  /**
   * R91: before a save the owner did not ask for (a first mark on a "not sure" PDF, a resumed save), "Never for this file" is
   * read again, since another tab may have chosen it. Then, or when it cannot be read, the PDF is "not learning", so the mark
   * asks first.
   */
  async function holdForChoice(): Promise<void> {
    if (state.kind !== 'unsure' || busy !== null || !d.rules) return;
    const now = await choiceNow();
    if (now === null || disposed || state.kind !== 'unsure' || busy !== null) return;
    decision = now === 'never' ? neverSaveDecision() : cannotCheck(decision);
    await dispatch({ type: 'never-save', reasons: [...decision.reasons] });
  }

  function run(effect: SaveEffect, cause: SaveCause, owner: OwnerForget | null = null): Promise<void> {
    if (effect.kind === 'ask') return Promise.resolve(); // the question shows while the state is `asking`
    if (busy !== null) {
      // One effect at a time. A second save while one runs is the same save; an owner's Forget waits its turn.
      if (busy.kind === effect.kind && owner === null) return busy.done;
      return busy.done.then(
        () => run(effect, cause, owner),
        () => run(effect, cause, owner),
      );
    }
    const kind = effect.kind;
    if (kind === 'save') {
      failed = false;
      boxDuringSave = false;
      savingCause = cause === 'resume' ? resumedCause : cause;
    }
    const done = (kind === 'save' ? saveEffect(effect.undoable, cause) : forgetEffect(owner)).then(
      () => {
        busy = null;
        notify();
        settleHeld(); // R91: a save that stopped for card or bank numbers
      },
      (error: unknown) => {
        busy = null;
        if (kind === 'save' && state.kind !== 'saved') failed = true; // R67 (a): the chip offers to try again
        if (kind === 'forget' && state.kind === 'saved' && state.undoable) startUndoTimer(); // Undo can be tried again
        notify();
        if (owner === null) for (const cb of [...failureListeners]) cb(kind); // the Forget dialog says it itself
        throw error;
      },
    );
    busy = { kind, done };
    notify();
    return done;
  }

  async function dispatch(e: SaveEvent): Promise<void> {
    if (disposed) return;
    const step = reduceSave(state, e);
    set(step.state);
    if (step.effect === null) return;
    const cause: SaveCause =
      e.type === 'classified'
        ? 'filter'
        : e.type === 'first-mark'
          ? e.undoable === false
            ? 'first-note'
            : 'first-mark'
          : e.type === 'resume-save'
            ? 'resume'
            : 'owner';
    await run(step.effect, cause);
  }

  /** Records this open of a PDF the library holds: its location and its history row. */
  async function recordKnownOpen(lib: StoreClient, documentId: DocumentId): Promise<void> {
    try {
      if (d.location !== null) await lib.touchLocation({ documentId, ...d.location, at: d.now() });
      await lib.recordOpen(documentId, d.now());
    } catch (error) {
      console.warn('sickofpdfs: this open was not recorded', error instanceof Error ? error.message.split(':')[0] : '');
    }
  }

  /**
   * Tabs in step (plan section 4 item 8): when another tab saves this PDF (a `documents` upsert), or records this copy
   * as an alias of a saved one, a tab that has not saved it yet looks again and follows: it becomes `saved` too. Not
   * while it is still checking (start() decides then), saving itself, or kept in memory because the owner said No here.
   * Following writes nothing: this tab's own open and address are recorded the next time the PDF is opened.
   */
  let following: Promise<void> | null = null;
  let lookAgain = false;
  /** Reads whether the saved document is in the Trash now, and tells the chip when that changed. */
  async function readTrashed(lib: StoreClient, documentId: DocumentId): Promise<void> {
    const row = await lib.getDocument(documentId).catch(() => null);
    const now = row !== null && row.deletedAt !== null;
    const noIndex = row !== null && row.indexText === false; // D9: saved without searchable text, here or before
    if (disposed || (now === trashed && noIndex === rowNotIndexed) || state.kind !== 'saved' || state.documentId !== documentId) return;
    trashed = now;
    rowNotIndexed = noIndex;
    notify();
  }

  function onLibraryChange(c: StoreChange): void {
    if (disposed) return;
    if (c.table === 'documents' && c.op === 'delete') {
      // R67 (d): another tab forgot this PDF (its Undo). This tab follows: "Not sure", and its notes session drops what
      // the store no longer has. Never "Saved" for a PDF that is not saved. While a save or Undo runs here, that decides.
      const mine = c.ids.includes(loaded.sha256) || (state.kind === 'saved' && c.ids.includes(state.documentId));
      if (mine) othersAdded = false;
      // TB4 ruling (Forget wins): what follows is decided once it is known whether this was the owner's Forget.
      if (mine && state.kind === 'saved' && busy === null && store !== null) void followDelete(store, state.documentId);
      return;
    }
    // R76 (d): the saved document went to the Trash, or came back (the library tab, another tab): the chip follows.
    if (c.table === 'documents' && c.op === 'upsert' && store !== null && state.kind === 'saved' && c.ids.includes(state.documentId)) {
      void readTrashed(store, state.documentId);
      return;
    }
    if (c.op !== 'upsert' || (c.table !== 'documents' && c.table !== 'aliases')) return;
    if (following !== null) {
      lookAgain = true;
      return;
    }
    following = (async () => {
      do {
        lookAgain = false;
        const lib = store;
        if (disposed || lib === null || busy !== null) return;
        if (state.kind !== 'unsure' && state.kind !== 'not-learning' && state.kind !== 'asking') return;
        const identity = await resolveIdentity({ sha256: loaded.sha256, pageCount: open.pageCount, pageTexts: allPageTexts }, lib).catch((): IdentityResult => ({ kind: 'unknown' }));
        // The state may have moved while the library was read (this tab saved, or the owner answered).
        if (identity.kind !== 'known' || disposed || (state as SaveState).kind === 'saved') continue;
        await dispatch({ type: 'identified', documentId: identity.documentId });
      } while (lookAgain);
    })().finally(() => {
      following = null;
    });
  }

  async function begin(): Promise<void> {
    if (d.incognito) return dispatch({ type: 'incognito' });
    [store, blobs] = await Promise.all([d.store, Promise.resolve(d.blobs).catch(() => null)]);
    if (store === null) {
      // No library in this tab: notes are kept until the tab closes.
      set({ kind: 'memory-only' });
      return;
    }
    if (!disposed) stopFollowing = store.onChange(onLibraryChange);

    let identity: IdentityResult = { kind: 'unknown' };
    try {
      identity = await resolveIdentity({ sha256: loaded.sha256, pageCount: open.pageCount, pageTexts: allPageTexts }, store);
    } catch (error) {
      // Treated as a new PDF: the owner can still save it. Nothing about the PDF goes in the message.
      console.warn('sickofpdfs: the library could not say whether it holds this PDF', error instanceof Error ? error.message.split(':')[0] : '');
    }
    if (identity.kind === 'known') {
      const documentId = identity.documentId;
      await recordKnownOpen(store, documentId);
      await dispatch({ type: 'identified', documentId });
      await readTrashed(store, documentId);
      return;
    }
    // The owner's choice for this exact file comes first, before any page is read.
    const chosen = d.fileChoice === undefined ? null : await d.fileChoice().catch(() => null);
    if (chosen !== null) {
      decision = chosen;
    } else {
      try {
        decision = await d.filter(await filterInput());
      } catch {
        decision = cannotCheck(null, FILTER_FAILED); // R91: a filter that fails saves nothing on its own, and a mark asks
      }
      // R91: "Never for this file" may have been chosen in another tab while this one was checking. R97: and it is read again
      // under the text fingerprint, now that the first pages are read, so another download of a "never" PDF is "never" too.
      if (d.rules) {
        const now = await choiceNow();
        if (now === 'never') decision = neverSaveDecision();
        else if (now === 'unknown' && decision.verdict !== 'not-learning') decision = cannotCheck(decision);
      }
    }
    if (disposed) return;
    try {
      await dispatch({ type: 'classified', decision }); // a learning verdict saves here
    } catch {
      // The automatic save failed: the owner can save it from the chip.
      if (state.kind === 'checking') set({ kind: 'unsure', reasons: decision.reasons });
    }
  }

  /** Waits for `start()` (when it was called), so a request made while the PDF is being identified is not lost. */
  const afterStart = async (): Promise<void> => {
    if (started !== null) await started.catch(() => {});
  };

  return {
    get state() {
      return state;
    },
    get busy() {
      return busy?.kind ?? null;
    },
    get savedReasons() {
      return savedReasons;
    },
    get failed() {
      return failed && state.kind !== 'saved';
    },
    get resuming() {
      return resuming && state.kind !== 'saved';
    },
    get savingCause() {
      return busy?.kind === 'save' ? savingCause : null;
    },
    documentId: () => (state.kind === 'saved' ? state.documentId : null),
    get trashed() {
      return state.kind === 'saved' && trashed;
    },
    get notSearchable() {
      return state.kind === 'saved' && (rowNotIndexed || saveWarning !== null);
    },
    get decision() {
      return decision;
    },
    get saveWarning() {
      return state.kind === 'saved' ? saveWarning : null;
    },
    get whyNotSaved() {
      return whyNotSaved;
    },
    get neverChosen() {
      return whyNotSaved === NEVER_SAVE_REASON;
    },
    siteRule,
    hasRules: d.rules !== undefined && d.rules !== null,
    async neverSave() {
      await afterStart();
      if (!d.rules || (state.kind !== 'unsure' && state.kind !== 'not-learning')) return;
      const keys = await choiceKeys(); // R97: the file and its text
      await d.rules.neverSave(keys);
      decision = neverSaveDecision();
      await dispatch({ type: 'never-save', reasons: [NEVER_SAVE_REASON] });
      tellNever(keys);
    },
    async alwaysForSite() {
      await afterStart();
      if (!d.rules || siteRule === null) return;
      await d.rules.allow(siteRule.entry);
      await dispatch({ type: 'save-requested' });
    },
    async forget(o) {
      await afterStart();
      if (busy !== null) await busy.done.catch(() => {});
      if (store === null || state.kind !== 'saved') throw new Error('not-saved: this PDF is not in the library');
      const owner: OwnerForget = { neverSave: o.neverSave };
      await run({ kind: 'forget' }, 'owner', owner);
      if (owner.done === undefined) throw new Error('not-saved: this PDF is not in the library');
      // After the effect, so a save the owner asks for meanwhile does not wait for the backup folder.
      return { backups: await scrub(owner.done.documentId), neverSave: owner.done.neverSave };
    },
    async report(label) {
      if (!d.rules) throw new Error('no-rules: reports are not kept here');
      await d.rules.report(loaded.sha256, label);
      reportedLearning = label === 'learning';
    },
    async contents() {
      if (store === null || state.kind !== 'saved') return { marks: 0, notes: 0 };
      const a = await store.listAnnotations(state.documentId);
      const marks = a.marks.filter((m) => m.deletedAt === null).length;
      const withText = new Set(a.comments.filter((c) => c.deletedAt === null && c.body.trim() !== '').map((c) => c.threadId));
      const sent = a.threads.filter((t) => t.deletedAt === null && withText.has(t.id)).length;
      // Notes still being typed, in any tab, are notes too: their crash-safe copies are in the journal.
      const ids = new Set([state.documentId, loaded.sha256]);
      const typing = [...ids].flatMap((id) => localDraftJournal()?.list(id) ?? []).filter((e) => e.kind === 'comment' && e.closing !== true && e.body.trim() !== '');
      return { marks, notes: sent + new Set(typing.map((e) => e.commentId)).size };
    },
    async restoreFromTrash() {
      if (store === null || state.kind !== 'saved') return;
      const id = state.documentId;
      await store.restoreDocument(id);
      await readTrashed(store, id);
    },
    async moveToTrash() {
      if (store === null || state.kind !== 'saved') return;
      const id = state.documentId;
      await store.trashDocument(id);
      await readTrashed(store, id);
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    onFailure(cb) {
      failureListeners.add(cb);
      return () => void failureListeners.delete(cb);
    },
    start: () => (started ??= begin()),
    async requestSave() {
      await afterStart();
      await dispatch({ type: 'save-requested' });
    },
    async firstMark(o) {
      // R67 (c, f): a note's save, or one with more than the first mark already made, gets no Undo; nor, once a note has
      // started a save here, does any later one (a failed note save, then a mark or Enter: R67 tightened 3).
      if (o?.undoable === false) noteSeen = true;
      const undoable = o?.undoable !== false && !noteSeen;
      moreHere = false;
      byNote = o?.undoable === false;
      triggerRows = typeof o?.rows === 'number' && o.rows > 0 ? o.rows : null;
      tellOthers(o?.content !== false); // for the other tabs this mark or note is more than their first mark
      await afterStart();
      await holdForChoice(); // R91: a "never" chosen in another tab makes this mark ask
      await dispatch({ type: 'first-mark', ...(undoable ? {} : { undoable: false }) });
    },
    endUndo(o) {
      if (disposed) return;
      const content = o?.content !== false;
      if (content) endUndoHere();
      else expireUndo(); // N1: an empty note box ends the Undo chip, and is not content
      tellOthers(content); // R67 tightened (1): always, so a tab on a copy still being identified counts it too
    },
    announce(o) {
      if (!disposed) tellOthers(o?.content !== false);
    },
    async withdraw() {
      // R67 (b): the note that saved the PDF was emptied and closed before anything else was made, in any tab.
      if (busy?.kind === 'save') await busy.done.catch(() => {});
      if (disposed || !byNote || !createdHere || moreHere || othersAdded || state.kind !== 'saved') return;
      byNote = false;
      await run({ kind: 'forget' }, 'owner', null);
    },
    async resumeSave(o) {
      // R67 tightened (3, 4): never with an Undo; the chip says "Saving your notes…" until the save lands. R105b: it keeps the reason
      // of the save its tab started.
      resumedCause = o?.cause ?? null;
      resuming = true;
      byNote = false;
      noteSeen = true;
      notify();
      await afterStart();
      if (disposed || state.kind === 'saved') {
        resuming = false;
        notify();
        return;
      }
      try {
        await holdForChoice(); // R91: as for a first mark
        await dispatch({ type: 'resume-save' });
      } finally {
        if (state.kind !== 'asking' && busy?.kind !== 'save') {
          resuming = false;
          notify();
        }
      }
    },
    async undo() {
      stopUndoTimer();
      if (state.kind === 'saved' && state.undoable && store !== null && !(await onlyTheFirstMark(store, state.documentId))) {
        await dispatch({ type: 'undo-expired' }); // more than the first mark is here: there is no Undo to give
        return;
      }
      await dispatch({ type: 'undo-requested' });
    },
    async answerAsk(save) {
      await dispatch({ type: 'ask-answered', save });
    },
    dispose() {
      disposed = true;
      stopFollowing?.();
      channel?.close();
      channel = null;
      stopUndoTimer();
      listeners.clear();
      failureListeners.clear();
    },
  };
}
