// How @Claude is asked (plan §8 A3, `ClaudeEntry`), and what a reply's buttons do: Stop, Try again and Think harder.
//
// The three ways in all come here:
// - "@Claude …" in a note or a reply: once the note is sent, `ask({ threadId })` (the thread's last note from the owner is the
//   question);
// - "Ask Claude" in the mark-up menu: `ask({ anchor }, { question })` makes the note and asks, or the UI opens a note with "@Claude "
//   ready and asks when it is sent;
// - "Explain this figure": `ask(…, { preset: 'explain-figure' })`, a fixed question about the figure the note is on.
//
// Before anything is sent, the PDF must be one Claude may read (R105, controller rulings of 6 Nov):
// - A private PDF (judged not learning, D9 or R102), or Incognito: never. Every Claude item is greyed out with "Claude doesn't
//   read private files", and a question asked anyway gets a row in its thread saying why, which stays until it is dismissed.
//   Nothing is sent. If the owner saves the PDF later, the row says "Claude did not read this".
// - A PDF the owner did not choose for Claude, judged when the question starts: not in the library (not sure, still checking, a
//   save that failed), or saved in this tab's visit only by a note or a mark. The first question asks "Send … to Anthropic?" with
//   Cancel the default, and sends only the pack (no tools, no web search), after the R91 card, bank and ID check. After one Send,
//   later questions on that reading in this tab do not ask again.
// - Anything else in the library: yes.
// Right before anything leaves, the library's row is read again, so a save that lands while a dialog waits (D9, R102) is caught.
//
// The entry is made for each open PDF by the `claude-entry` viewer feature (one line in App.tsx). It is published on the viewer's
// runtime (A3) and through `claudeEntry`, where the Claude UI (slice F) finds it.
import {
  estimate, HARD_BLOCK_REASON, type Anchor, type ClaudeReplyMeta, type ContextPack, type CommentId, type CommentRow, type DocumentId, type ModelChoice,
  type ModelRole, type ThreadId, type ThreadRow,
} from '@sop/core';
import { createElement, useEffect } from 'react';
import type { StoreClient } from '../../store/client';
import { SAVED_THOUGH_NOT_LEARNING } from '../../store/reading-flags';
import type { NotesHost, ViewerFeature } from '../annotations/wire';
import { isIncognito } from '../incognito';
import { publishRuntime } from '../runtime';
import { claudeNoteWaiting } from '../save/claude-note';
import { SAVED_BY_FIRST_MARK, SAVED_BY_FIRST_NOTE, SAVED_BY_OWNER } from '../save/save-controller';
import { libraryStore } from '../use-store';
import { createClaudeClient, hasKey } from './client';
import { createContextBuilder, createWorkerEmbedder, type ContextBuilder } from './context';
import { CUT_SHORT_MESSAGE, NOT_READ_MESSAGE, PRIVATE_HINT, PRIVATE_MESSAGES, type PrivateReason } from './errors';
import { createThreadHistory, mentionsClaude, questionText } from './history';
import { createReplyRows, isClaudeMeta, type ReplyRows } from './reply-rows';
import type { ClaudeEntryHost } from './entry-api';
import { createSpend } from './spend';
import { createTurnRunner, type AbortReason, type ConfirmRequest, type LiveSink, type TurnRequest, type TurnSettings } from './turn';
import { confirmClaude } from './ui/ClaudeConfirmDialog';
import { claudeUi, type ClaudeUiHost } from './ui/host';
import { claudeLive } from './ui/ReplyStatus';

export type { ClaudeEntry, ClaudeEntryHost } from './entry-api';

/** What the Claude UI gives the entry: the confirm dialog it waits on, and the live view of a reply. Without them, nothing is asked: No. */
export interface EntryUi {
  confirm?(r: ConfirmRequest): Promise<boolean>;
  live?: LiveSink | null;
}

/** The synced settings rows of contract §6 (slice G writes them). */
const KEYS = {
  modelDefault: 'claude.model.default',
  modelThinkHarder: 'claude.model.thinkHarder',
  webSearch: 'claude.webSearch',
  monthlyCapUsd: 'claude.monthlyCapUsd',
  confirmOverUsd: 'claude.confirmOverUsd',
} as const;
const DEFAULT_CONFIRM_OVER_USD = 0.25;
/** How long a question waits for the PDF's save to land (a first note's keystroke starts it) before it gives up as "not saved". */
const SAVE_WAIT_MS = 30_000;
/** A moment for a save the note's first keystroke started to show as busy. */
const SAVE_GRACE_MS = 200;
/** The save states in which the PDF is not in the library. Seen once in this tab's visit, a later note-made save is not a choice. */
const OUTSIDE = new Set(['unsure', 'not-learning', 'asking', 'memory-only']);
/** The save states of a PDF judged private (not learning: the save question, its No, "Never save this file"). */
const PRIVATE_KINDS = new Set(['not-learning', 'asking', 'memory-only']);

/** The save controller's view of why the PDF is not saved, where it gives one (SaveControllerImpl). */
type SaveWhy = { decision?: { rule?: string; reasons?: readonly string[] } | null; whyNotSaved?: string | null };

/** What a reading's row says for Claude: D9 (`indexText`), R102 (`notLearning`), and whether only a note or a mark saved it. */
interface ReadingFlags {
  indexText: boolean;
  notLearning: boolean;
  /** Saved by a first note or a first mark, never by the owner's own Save (R105: not the owner's choice for Claude). */
  byNote: boolean;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const newId = <T extends string>(): T => String(crypto.randomUUID()) as T;

/** A stored model choice (A1), or null when the row is missing or not one. Ids are data and are never compared with code. */
export function parseModelChoice(v: unknown): ModelChoice | null {
  if (!isRec(v) || typeof v.id !== 'string' || v.id === '' || typeof v.displayName !== 'string') return null;
  return {
    id: v.id,
    displayName: v.displayName,
    line: typeof v.line === 'string' ? v.line : null,
    imageInput: v.imageInput === true,
    webSearchTool: typeof v.webSearchTool === 'string' && v.webSearchTool !== '' ? v.webSearchTool : null,
    maxInputTokens: typeof v.maxInputTokens === 'number' && Number.isFinite(v.maxInputTokens) ? v.maxInputTokens : null,
    checkedAt: typeof v.checkedAt === 'number' ? v.checkedAt : 0,
    ...(v.serverFallback === true ? { serverFallback: true } : {}),
  };
}

const usdOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** The owner's Claude settings from the library's settings rows. */
export async function readTurnSettings(store: Pick<StoreClient, 'getSetting'>): Promise<TurnSettings> {
  const [d, t, web, cap, over] = await Promise.all([
    store.getSetting(KEYS.modelDefault), store.getSetting(KEYS.modelThinkHarder), store.getSetting(KEYS.webSearch),
    store.getSetting(KEYS.monthlyCapUsd), store.getSetting(KEYS.confirmOverUsd),
  ].map((p) => p.catch(() => null)));
  return {
    models: { 'default': parseModelChoice(d), 'think-harder': parseModelChoice(t) },
    webSearch: web !== false,
    capUsd: usdOrNull(cap),
    confirmOverUsd: usdOrNull(over) ?? DEFAULT_CONFIRM_OVER_USD,
  };
}

/** The one entry of this tab, while a PDF is open: the Claude UI finds it here (and is told when it changes). */
export const claudeEntry = (() => {
  let current: ClaudeEntryHost | null = null;
  const listeners = new Set<() => void>();
  return {
    get: (): ClaudeEntryHost | null => current,
    set(e: ClaudeEntryHost | null): void {
      if (current === e) return;
      current = e;
      for (const cb of [...listeners]) cb();
    },
    subscribe(cb: () => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
})();

export function createClaudeEntry(host: NotesHost, ui: EntryUi = {}): ClaudeEntryHost {
  const session = host.session;
  const tabId = session.tabId;
  const incognito = isIncognito();
  let store: StoreClient | null = null;
  const storeReady = libraryStore().then((s) => (store = s));
  let keyKnown: boolean | null = null;
  let settings: TurnSettings | null = null;
  let disposed = false;
  const flags = new Map<DocumentId, ReadingFlags | null>();
  /** R105: this tab saw the PDF outside the library (not sure, not learning) during this visit. */
  let seenOutside = host.save !== undefined && OUTSIDE.has(host.save.state.kind);
  /** R105: the owner said Send to "Send … to Anthropic?" for this reading, in this tab. Later questions do not ask again. */
  let agreed = false;
  /** A question here has built its pack (the local search is warm): later ones do not say "Getting ready…". */
  let warm = false;
  /** R105: the private refusals shown in this tab, with whether the PDF was in the library then (for "Claude did not read this"). */
  const refusals = new Map<CommentId, { stored: boolean }>();
  const privacyListeners = new Set<() => void>();
  const tellPrivacy = () => {
    for (const cb of [...privacyListeners]) {
      try {
        cb();
      } catch {
        /* one listener must not stop the others */
      }
    }
  };
  const running = new Map<CommentId, { abort: AbortController; threadId: ThreadId }>();
  const queues = new Map<ThreadId, Promise<unknown>>();
  const presets = new Map<CommentId, 'explain-figure' | 'whole-document'>();
  /**
   * The questions already asked in this tab. A note is asked about once: the Claude UI's mention watch also calls `ask` when an
   * @Claude note is sent, and a note this entry sent itself (`ask({ anchor })`) must not be asked twice.
   */
  const asked = new Set<CommentId>();
  /** The last pack each thread was answered with in this tab, for the Think harder estimate. */
  const packs = new Map<ThreadId, ContextPack>();
  const history = createThreadHistory();
  const spend = createSpend();
  const embedder = createWorkerEmbedder();
  let builder: { documentId: DocumentId; saved: boolean; context: ContextBuilder } | null = null;
  const log = (e: unknown, where: string) => console.warn(`sickofpdfs: claude (${where})`, e instanceof Error ? e.message : String(e));

  const refreshKey = () => {
    if (incognito) return;
    void hasKey().then((k) => (keyKnown = k), () => (keyKnown = false));
  };
  refreshKey();
  const onFocus = () => {
    if (document.visibilityState !== 'visible') return;
    refreshKey();
    sweep();
  };
  document.addEventListener('visibilitychange', onFocus);
  window.addEventListener('focus', onFocus);

  /** The library id the notes are written under, while they are; null otherwise. */
  const storedDocumentId = (): DocumentId | null => {
    if (session.state().mode !== 'stored') return null;
    const st = session.state();
    return st.threads.find((t) => t.draftOfTab === null)?.documentId ?? st.threads[0]?.documentId ?? (host.save as { documentId?: () => DocumentId | null } | undefined)?.documentId?.() ?? null;
  };

  const rows: ReplyRows = createReplyRows({
    session,
    get store() {
      return store;
    },
    tabId,
    storedDocumentId,
    now: () => Date.now(),
    onError: log,
  });

  /**
   * Whether Claude may read this PDF now, from what this tab knows (the flags as last read):
   * - saved, and not D9 or R102: yes (`saved: true`);
   * - not saved, and the filter was not sure (or is still checking): yes, but only after the owner says Send (`saved: false`);
   * - judged not learning (the save question, its No, "Never save this file"), D9, R102, Incognito: never, with the reason.
   */
  /** A PDF judged private: "it has card, bank or ID numbers" when that is why (R91, D9), otherwise "it looked private". */
  const judgedPrivate = (): PrivateReason => {
    const why = host.save as SaveWhy | undefined;
    const numbers = why?.decision?.rule === 'hard-block' || why?.whyNotSaved === HARD_BLOCK_REASON || why?.decision?.reasons?.[0] === HARD_BLOCK_REASON;
    return numbers ? 'no-text' : 'not-learning';
  };

  const privacyNow = (documentId: DocumentId | null): { reason: PrivateReason | null; saved: boolean } => {
    if (incognito) return { reason: 'incognito', saved: false };
    const kind = host.save?.state.kind ?? null;
    if (kind === 'saved' || (kind === null && session.state().mode === 'stored')) {
      if (session.state().mode !== 'stored' || documentId === null) return { reason: 'unsaved', saved: false }; // forgotten in another tab
      const f = flags.get(documentId);
      if (f === undefined || f === null) return { reason: 'unsaved', saved: false }; // not known to be in the library
      if (!f.indexText) return { reason: 'no-text', saved: true };
      if (f.notLearning) return { reason: 'not-learning', saved: true };
      return { reason: null, saved: true };
    }
    if (kind === 'unsure' || kind === 'checking') return { reason: null, saved: false };
    if (kind === 'incognito') return { reason: 'incognito', saved: false };
    return { reason: judgedPrivate(), saved: false }; // not-learning, asking, memory-only (the owner said No)
  };

  /** The reading's row as the library has it now (D9, R102 and the save reasons are on it), or null when it is not there. */
  async function readFlags(documentId: DocumentId): Promise<ReadingFlags | null> {
    await storeReady;
    let f: ReadingFlags | null = null;
    if (store) {
      try {
        const row = await store.getDocument(documentId);
        if (row && row.deletedAt === null) {
          const reasons = Array.isArray(row.saveReasons) ? row.saveReasons : [];
          f = {
            indexText: row.indexText,
            notLearning: reasons.includes(SAVED_THOUGH_NOT_LEARNING),
            byNote: (reasons.includes(SAVED_BY_FIRST_NOTE) || reasons.includes(SAVED_BY_FIRST_MARK)) && !reasons.includes(SAVED_BY_OWNER),
          };
        }
      } catch (e) {
        log(e, 'getDocument');
      }
    }
    flags.set(documentId, f);
    return f;
  }

  /**
   * The check right before anything leaves (and at the start of every turn): what `privacyNow` says, with the library's row read
   * again. A turn for a PDF not chosen for Claude (`restricted`) may go on while the PDF is still not in the library; once it is
   * saved, the new reading's own flags decide (TB6 security 2: a save that lands while the dialog waits never skips this).
   */
  async function privacyCheck(restricted: boolean): Promise<PrivateReason | null> {
    if (incognito) return 'incognito';
    const kind = host.save?.state.kind ?? null;
    if (kind !== null && PRIVATE_KINDS.has(kind)) return judgedPrivate();
    if (kind === 'incognito') return 'incognito';
    if (kind === 'unsure' || kind === 'checking') return restricted ? null : 'unsaved'; // forgotten or undone since the turn began
    const id = storedDocumentId() ?? (host.save as { documentId?: () => DocumentId | null } | undefined)?.documentId?.() ?? null;
    if (id === null) return restricted ? null : 'unsaved';
    const f = await readFlags(id);
    if (disposed) return 'unsaved';
    if (f === null) return 'unsaved';
    if (!f.indexText) return 'no-text';
    if (f.notLearning) return 'not-learning';
    // The state may have moved while the row was read (a Forget, "Never save this file").
    const again = host.save?.state.kind ?? null;
    if (again !== null && again !== 'saved') return PRIVATE_KINDS.has(again) ? judgedPrivate() : restricted && (again === 'unsure' || again === 'checking') ? null : 'unsaved';
    return null;
  }

  /** R105, for the Claude items: the reason this PDF is private now (not learning, D9, R102), or null. */
  const privateNow = (): PrivateReason | null => {
    const r = privacyNow(storedDocumentId()).reason;
    return r === 'not-learning' || r === 'no-text' ? r : null;
  };

  // The Claude items follow the PDF's privacy: the save state, and (once saved) the reading's flags.
  let lastPrivate = privateNow();
  const privacyMoved = () => {
    const now = privateNow();
    if (now === lastPrivate) return;
    lastPrivate = now;
    tellPrivacy();
  };
  const refreshFlags = () => {
    const id = storedDocumentId();
    if (id === null) return privacyMoved();
    void readFlags(id).then(privacyMoved, privacyMoved);
  };
  const stopSave = host.save?.subscribe((st) => {
    if (OUTSIDE.has(st.kind)) seenOutside = true;
    refreshFlags();
  });
  void session.ready.then(refreshFlags, refreshFlags);

  /** A save is on its way (the first note's keystroke starts one), or the save question is open: the answer is worth waiting for. */
  const saving = (): boolean => {
    const save = host.save;
    if (!save) return session.state().mode === 'pending-save';
    return save.busy === 'save' || save.state.kind === 'asking' || (save.state.kind === 'saved' && session.state().mode !== 'stored');
  };

  /**
   * Waits for a save on its way, then says whether this PDF is in the library, and whether the owner chose it for Claude (R105,
   * judged when the question starts: a PDF this tab saw outside the library, then saved only by a note or a mark, was not chosen).
   */
  async function settle(threadId: ThreadId): Promise<{ documentId: DocumentId | null; inLibrary: boolean; chosen: boolean }> {
    if (incognito) return { documentId: null, inLibrary: false, chosen: false };
    // R105: while the question waits for the save, a save question it raised (a PDF judged not learning) is answered No for it.
    const done = claudeNoteWaiting.begin();
    try {
      await sleep(SAVE_GRACE_MS); // a note's first keystroke may have only just started the save
      const until = Date.now() + SAVE_WAIT_MS;
      while (saving() && Date.now() < until && !disposed) await sleep(150);
    } finally {
      done();
    }
    const thread = session.state().threads.find((t) => t.id === threadId) ?? null;
    // Before a save lands the rows carry the file's fingerprint as their document id (R67): the reply then stays in this tab.
    const documentId = thread?.documentId ?? storedDocumentId();
    const stored = storedDocumentId();
    const f = stored !== null ? await readFlags(stored) : null;
    const p = privacyNow(stored ?? documentId);
    const inLibrary = p.saved && p.reason === null;
    return { documentId, inLibrary, chosen: inLibrary && !(seenOutside && f?.byNote === true) };
  }

  /** The pack builder for this PDF. A PDF not in the library uses no library search and keeps no vectors in the library. */
  const contextFor = (documentId: DocumentId, saved: boolean): ContextBuilder => {
    if (builder?.documentId === documentId && builder.saved === saved) return builder.context;
    builder?.context.dispose();
    const context = createContextBuilder({
      documentId,
      backend: host.backend,
      doc: host.doc,
      pages: host.pages,
      pageText: host.pageText,
      figures: host.figures,
      metadataTitle: host.opened.open.metadata.title,
      store: saved ? store : null,
      embedder,
    });
    builder = { documentId, saved, context };
    return context;
  };

  const loadSettings = async (): Promise<TurnSettings> => {
    await storeReady;
    settings = store ? await readTurnSettings(store) : { models: { 'default': null, 'think-harder': null }, webSearch: true, capUsd: null, confirmOverUsd: DEFAULT_CONFIRM_OVER_USD };
    return settings;
  };

  const threadOf = (id: ThreadId): ThreadRow | null => session.state().threads.find((t) => t.id === id) ?? null;
  const commentsOf = (id: ThreadId): CommentRow[] => session.state().comments.filter((c) => c.threadId === id);
  /** The thread's anchor as placed in this file, or as stored when it could not be placed. */
  const anchorOf = (t: ThreadRow): Anchor => {
    const p = session.state().placement.get(t.id);
    return p?.placed === true ? p.anchor : t.anchor;
  };
  const rowOf = (id: CommentId): CommentRow | null => rows.held(id) ?? session.state().comments.find((c) => c.id === id) ?? null;

  /** The owner removed a reply that no turn here is writing: its draft goes from the store too. */
  const onRemoveFor = (id: CommentId) => () => {
    refusals.delete(id);
    const r = running.get(id);
    if (r) return r.abort.abort('removed' satisfies AbortReason);
    void storeReady.then(() => store?.discardDraft(id)).catch((e: unknown) => log(e, 'discard'));
  };

  /**
   * Runs one turn, after any turn still running in the same thread (a follow-up waits for the answer before it). Every way in comes
   * here (a note, a reply, the menus, Explain this figure, the whole document, Think harder, Try again), so every one gets the same
   * privacy checks; a refusal is the turn's own row in the thread.
   */
  function start(o: { threadId: ThreadId; questionId: CommentId; replyId: CommentId; role: ModelRole; preset?: 'explain-figure' | 'whole-document'; skip?: CommentId[]; moreRoom?: boolean; estimateUsd?: number }): void {
    const prev = queues.get(o.threadId) ?? Promise.resolve();
    const job = prev.then(async () => {
      if (disposed) return;
      const s = await settle(o.threadId);
      const thread = threadOf(o.threadId);
      if (!thread || disposed) return;
      const abort = new AbortController();
      running.set(o.replyId, { abort, threadId: o.threadId });
      if (o.preset) presets.set(o.replyId, o.preset);
      const documentId = s.documentId ?? thread.documentId;
      // R105: a PDF the owner did not choose for Claude sends only the pack, and asks first until the owner has said Send once. A
      // reading in the library that the owner has said Send for is theirs for Claude from then on, tools and all.
      const saved = s.chosen || (agreed && s.inLibrary);
      const askFirst = !s.chosen && !agreed;
      const runner = createTurnRunner({
        client: createClaudeClient,
        context: contextFor(documentId, s.inLibrary),
        rows: {
          // The reply row is shown with a way back to this entry when the owner deletes it.
          begin: (b) => rows.begin({ ...b, onRemove: onRemoveFor(b.id) }),
          sweep: (a, b) => rows.sweep(a, b),
          held: (id) => rows.held(id),
        },
        history,
        settings: loadSettings,
        spend,
        confirm: (r) => (ui.confirm ? ui.confirm(r) : Promise.resolve(false)),
        // At the start, and again right before anything leaves (a save, a Forget, "Never save this file" while the owner answered).
        privacy: () => privacyCheck(!saved),
        agreed: () => {
          agreed = true;
        },
        preparing: () => !warm || !embedder.alive(),
        comments: commentsOf,
        pageCount: host.pages.length,
        live: ui.live ?? null,
        now: () => Date.now(),
        onError: log,
      });
      const req: TurnRequest = {
        documentId, threadId: o.threadId, questionId: o.questionId, replyId: o.replyId, role: o.role,
        scope: o.preset === 'whole-document' ? 'whole-document' : 'passages',
        webSearch: settings?.webSearch ?? true,
        focus: anchorOf(thread),
        saved,
        askFirst,
        inLibrary: s.inLibrary,
        ...(o.preset ? { preset: o.preset } : {}),
        ...(o.skip ? { skip: o.skip } : {}),
        ...(o.moreRoom ? { moreRoom: true } : {}),
        ...(o.estimateUsd !== undefined ? { estimateUsd: o.estimateUsd } : {}),
      };
      try {
        const meta: ClaudeReplyMeta = await runner.run(req, () => undefined, abort.signal);
        if (meta.error?.code === 'no-key') refreshKey();
        // A private refusal (no model, nothing sent): remembered, so a save later can say "Claude did not read this".
        if (meta.role === null && meta.error?.code === 'refused' && rows.held(o.replyId) !== null) refusals.set(o.replyId, { stored: storedDocumentId() !== null });
      } finally {
        running.delete(o.replyId);
        const pack = runner.lastPack(o.threadId);
        if (pack) {
          packs.set(o.threadId, pack);
          warm = true;
        }
      }
    });
    const tail = job.catch((e: unknown) => log(e, 'turn'));
    queues.set(o.threadId, tail);
    void tail.then(() => {
      if (queues.get(o.threadId) === tail) queues.delete(o.threadId);
    });
  }

  /**
   * About what Think harder costs on this thread: the thread's last pack, with the Think harder model and the question's words.
   * The button's tooltip shows it, and the Think harder turn asks first with this same amount (one estimate, TB6).
   */
  const thinkHarderEstimate = (threadId: ThreadId): number | null => {
    const pack = packs.get(threadId) ?? null;
    const model = settings?.models['think-harder'] ?? null;
    if (!pack || !model) return null;
    const words = questionText(lastQuestion(threadId)?.body ?? '');
    const usd = estimate(pack, 'think-harder', model, { webSearch: settings?.webSearch === true && model.webSearchTool !== null, questionTokens: Math.ceil(words.length / 4) + 20 }).usd;
    return Number.isFinite(usd) ? usd : null;
  };

  /** The owner's latest sent note in the thread: the question. */
  const lastQuestion = (threadId: ThreadId): CommentRow | null =>
    commentsOf(threadId).filter((c) => c.author === 'me' && c.draftOfTab === null && c.body.trim() !== '').sort((a, b) => a.createdAt - b.createdAt).at(-1) ?? null;

  // Contract §3 step 5, once the saved PDF's notes are in: replies left half-written by a tab that is gone become "interrupted".
  // TB6 security 8: again whenever the tab comes back into view, after the session has adopted the drafts of tabs that are gone,
  // so a reply cut off when another tab closed shows here without a reload.
  let sweeping: Promise<void> | null = null;
  const sweep = () => {
    if (disposed || session.state().mode !== 'stored') return;
    sweeping ??= rows.sweep((id) => running.has(id), onRemoveFor).catch((e: unknown) => log(e, 'sweep')).finally(() => (sweeping = null));
  };
  void (async () => {
    await session.ready.catch(() => undefined);
    await storeReady;
    const until = Date.now() + 15_000;
    while (!disposed && session.state().mode !== 'stored' && Date.now() < until) await sleep(250);
    sweep();
  })();

  // R105: a question refused while the PDF was private, on a PDF saved afterwards: its row says "Claude did not read this" (and is
  // kept with the note, as a row of this computer's). A row the owner dismissed is left alone.
  let wasStored = session.state().mode === 'stored';
  const stopSession = session.subscribe(() => {
    const stored = session.state().mode === 'stored';
    if (stored === wasStored) return;
    wasStored = stored;
    refreshFlags();
    if (!stored) return;
    const documentId = storedDocumentId();
    if (documentId === null) return;
    for (const [id, r] of [...refusals]) {
      if (r.stored) continue;
      const row = rows.held(id);
      if (row === null || !isClaudeMeta(row.meta)) {
        refusals.delete(id);
        continue;
      }
      refusals.set(id, { stored: true });
      const meta: ClaudeReplyMeta = { ...row.meta, status: 'error', error: { code: 'refused', message: NOT_READ_MESSAGE } };
      void rows.begin({ id, threadId: row.threadId, documentId, meta, createdAt: row.createdAt, onRemove: onRemoveFor(id) }).fail('', meta).catch((e: unknown) => log(e, 'not-read'));
    }
  });

  const entry: ClaudeEntryHost = {
    status: () => (incognito ? 'incognito' : keyKnown === false ? 'no-key' : 'ready'),

    async ask(target, o) {
      if (incognito) {
        host.showNote(PRIVATE_MESSAGES.incognito);
        return 'threadId' in target ? target.threadId : ('' as ThreadId);
      }
      let threadId: ThreadId;
      let question: CommentRow | null;
      if ('anchor' in target) {
        const words = o?.question?.trim() ?? (o?.preset === 'explain-figure' ? 'Explain this figure.' : '');
        const made = session.startThread(target.anchor, { highlight: null });
        threadId = made.threadId;
        session.setActive(threadId);
        if (words === '') {
          // A note with "@Claude " ready: the owner types the question, and sending it asks (the UI's mention watch).
          session.typeDraft(made.commentId, '@Claude ');
          return threadId;
        }
        session.typeDraft(made.commentId, `@Claude ${words}`);
        asked.add(made.commentId); // before the send: the mention watch sees the sent note at once
        await session.send(made.commentId);
        question = session.state().comments.find((c) => c.id === made.commentId) ?? null;
      } else {
        threadId = target.threadId;
        question = lastQuestion(threadId);
        if (question !== null && asked.has(question.id)) return threadId;
      }
      if (question === null) return threadId;
      asked.add(question.id);
      start({ threadId, questionId: question.id, replyId: newId<CommentId>(), role: 'default', ...(o?.preset ? { preset: o.preset } : {}) });
      return threadId;
    },

    stop(replyId) {
      running.get(replyId)?.abort.abort('stop' satisfies AbortReason);
    },

    retry(replyId) {
      if (running.has(replyId)) return;
      const row = rowOf(replyId);
      if (!row || !isClaudeMeta(row.meta)) return;
      const meta = row.meta;
      const question = meta.questionId ?? lastQuestion(row.threadId)?.id ?? null;
      if (question === null) return;
      const qRow = session.state().comments.find((c) => c.id === question);
      const preset = presets.get(replyId) ?? (meta.scope === 'whole-document' ? 'whole-document' : qRow && /explain this figure/i.test(qRow.body) && mentionsClaude(qRow.body) ? 'explain-figure' : undefined);
      // R105: an answer cut short by the length limit asks again with more room (the same reply, a bigger limit).
      const cut = (meta as { cutShort?: unknown }).cutShort === true || meta.error?.message === CUT_SHORT_MESSAGE;
      start({ threadId: row.threadId, questionId: question, replyId, role: meta.role ?? 'default', ...(preset ? { preset } : {}), ...(cut ? { moreRoom: true } : {}) });
    },

    thinkHarder(threadId, replyId) {
      const row = rowOf(replyId);
      const meta = row && isClaudeMeta(row.meta) ? row.meta : null;
      const question = meta?.questionId ?? lastQuestion(threadId)?.id ?? null;
      if (question === null) return;
      const preset = presets.get(replyId) ?? (meta?.scope === 'whole-document' ? 'whole-document' : undefined);
      // One cost for Think harder (TB6): the ask-first dialog says the same amount the button's tooltip said.
      const usd = thinkHarderEstimate(threadId);
      start({ threadId, questionId: question, replyId: newId<CommentId>(), role: 'think-harder', skip: [replyId], ...(preset ? { preset } : {}), ...(usd !== null ? { estimateUsd: usd } : {}) });
    },

    model(role) {
      if (settings === null) void loadSettings().catch(() => undefined);
      const m = settings?.models[role] ?? null;
      return m ? { displayName: m.displayName } : null;
    },

    thinkHarderUsd: (threadId) => thinkHarderEstimate(threadId),

    privacy: () => privacyNow(storedDocumentId()).reason,
    privateHint: () => (privateNow() !== null ? PRIVATE_HINT : null),
    onPrivacyChange(cb) {
      privacyListeners.add(cb);
      return () => void privacyListeners.delete(cb);
    },
    running: (id) => running.has(id),

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const r of running.values()) r.abort.abort('stop' satisfies AbortReason);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
      stopSave?.();
      stopSession();
      privacyListeners.clear();
      embedder.dispose();
      builder?.context.dispose();
      if (claudeEntry.get() === entry) claudeEntry.set(null);
    },
  };
  return entry;
}

/** Makes the entry for the open PDF, publishes it, and ends it with the PDF. */
function ClaudeEntryView({ host }: { host: NotesHost }) {
  useEffect(() => {
    const entry = createClaudeEntry(host, claudeEntryUi);
    claudeEntry.set(entry);
    publishRuntime({ claude: entry });
    return () => {
      entry.dispose();
      publishRuntime({ claude: null });
    };
  }, [host]);
  return null;
}

/** The Claude UI's side (slice F): its confirm dialog, which the turn waits on, and its live view of a reply. */
export const claudeEntryUi: EntryUi = { confirm: confirmClaude, live: claudeLive };

/**
 * The tab's one host for the Claude UI (slice F's seam, `ui/host.ts`): set once, when the viewer starts, before a PDF opens, so the
 * Claude commands and menu rows are built with the PDF. It hands every call to the entry of the PDF open now; with none open,
 * nothing happens.
 */
const privacyFollowers = new Set<() => void>();
let unfollow: (() => void) | null = null;
/** The tab host's privacy listeners follow whichever entry is current (one PDF at a time). */
claudeEntry.subscribe(() => {
  unfollow?.();
  const e = claudeEntry.get();
  unfollow = e ? e.onPrivacyChange(() => privacyFollowers.forEach((cb) => cb())) : null;
  privacyFollowers.forEach((cb) => cb());
});

export const claudeTabHost: ClaudeUiHost = {
  ask: (target, o) => claudeEntry.get()?.ask(target, o) ?? Promise.resolve('threadId' in target ? target.threadId : ('' as ThreadId)),
  privateHint: () => claudeEntry.get()?.privateHint() ?? null,
  onPrivacyChange(cb) {
    privacyFollowers.add(cb);
    return () => void privacyFollowers.delete(cb);
  },
  status: () => claudeEntry.get()?.status() ?? (isIncognito() ? 'incognito' : 'ready'),
  stop: (replyId) => claudeEntry.get()?.stop(replyId),
  retry: (replyId) => claudeEntry.get()?.retry(replyId),
  thinkHarder: (threadId, replyId) => claudeEntry.get()?.thinkHarder(threadId, replyId),
  model: (role) => claudeEntry.get()?.model(role) ?? null,
  thinkHarderUsd: (threadId) => claudeEntry.get()?.thinkHarderUsd(threadId) ?? null,
};
claudeUi.set(claudeTabHost);

/** Phase 4 (slice D): App.tsx registers it with one line, `registerViewerFeature(claudeEntryFeature)`. */
export const claudeEntryFeature: ViewerFeature = {
  id: 'claude-entry',
  View: (props) => createElement(ClaudeEntryView, props),
};
