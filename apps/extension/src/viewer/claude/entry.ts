// How @Claude is asked (plan §8 A3, `ClaudeEntry`), and what a reply's buttons do: Stop, Try again and Think harder.
//
// The three ways in all come here:
// - "@Claude …" in a note or a reply: once the note is sent, `ask({ threadId })` (the thread's last note from the owner is the
//   question);
// - "Ask Claude" in the mark-up menu: `ask({ anchor }, { question })` makes the note and asks, or the UI opens a note with "@Claude "
//   ready and asks when it is sent;
// - "Explain this figure": `ask(…, { preset: 'explain-figure' })`, a fixed question about the figure the note is on.
//
// Before anything is sent, the PDF must be one Claude may read. Claude never reads a PDF that is not in the library, a reading saved
// without searchable text (D9: it holds card, bank or ID numbers) or a reading saved against the filter's "not learning" (R102: a
// receipt, a statement, a CV). Then nothing is sent, and the note bar says why, in plain words. Nothing is stored about it either.
//
// The entry is made for each open PDF by the `claude-entry` viewer feature (one line in App.tsx). It is published on the viewer's
// runtime (A3) and through `claudeEntry`, where the Claude UI (slice F) finds it.
import {
  estimate, type Anchor, type ClaudeReplyMeta, type ContextPack, type CommentId, type CommentRow, type DocumentId, type ModelChoice,
  type ModelRole, type ThreadId, type ThreadRow,
} from '@sop/core';
import { createElement, useEffect } from 'react';
import type { StoreClient } from '../../store/client';
import { SAVED_THOUGH_NOT_LEARNING } from '../../store/reading-flags';
import type { NotesHost, ViewerFeature } from '../annotations/wire';
import { isIncognito } from '../incognito';
import { publishRuntime } from '../runtime';
import { libraryStore } from '../use-store';
import { createClaudeClient, hasKey } from './client';
import { createContextBuilder, createWorkerEmbedder, type ContextBuilder } from './context';
import { PRIVATE_MESSAGES, type PrivateReason } from './errors';
import { createThreadHistory, mentionsClaude } from './history';
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
  const flags = new Map<DocumentId, { indexText: boolean; notLearning: boolean } | null>();
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
    if (document.visibilityState === 'visible') refreshKey();
  };
  document.addEventListener('visibilitychange', onFocus);
  window.addEventListener('focus', onFocus);

  /** The library id the notes are written under, while they are; null otherwise. */
  const storedDocumentId = (): DocumentId | null => {
    if (session.state().mode !== 'stored') return null;
    const st = session.state();
    return st.threads.find((t) => t.draftOfTab === null)?.documentId ?? st.threads[0]?.documentId ?? null;
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
   * Whether Claude may read this PDF now (controller ruling, 6 Nov; spec "On a PDF that isn't in your library, Claude asks before any
   * text is sent"):
   * - saved, and not D9 or R102: yes;
   * - not saved, and the filter was not sure (or is still checking): yes, but only after the owner says Send (`saved: false`);
   * - judged not learning (the save question, its No, "Never save this file"), D9, R102, Incognito: never, with the reason.
   */
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
    return { reason: 'not-learning', saved: false }; // not-learning, asking, memory-only (the owner said No)
  };

  /** Reads the reading's row again (D9 and R102 are on it). */
  async function readFlags(documentId: DocumentId): Promise<void> {
    await storeReady;
    if (!store) return void flags.set(documentId, null);
    try {
      const row = await store.getDocument(documentId);
      flags.set(documentId, row && row.deletedAt === null ? { indexText: row.indexText, notLearning: row.saveReasons.includes(SAVED_THOUGH_NOT_LEARNING) } : null);
    } catch (e) {
      log(e, 'getDocument');
      flags.set(documentId, null);
    }
  }

  /** A save is on its way (the first note's keystroke starts one), or the save question is open: the answer is worth waiting for. */
  const saving = (): boolean => {
    const save = host.save;
    if (!save) return session.state().mode === 'pending-save';
    return save.busy === 'save' || save.state.kind === 'asking' || (save.state.kind === 'saved' && session.state().mode !== 'stored');
  };

  /** Waits for a save on its way, then says whether Claude may read this PDF, and whether it is in the library. */
  async function settle(threadId: ThreadId): Promise<{ reason: PrivateReason | null; documentId: DocumentId | null; saved: boolean }> {
    if (incognito) return { reason: 'incognito', documentId: null, saved: false };
    await sleep(SAVE_GRACE_MS); // a note's first keystroke may have only just started the save
    const until = Date.now() + SAVE_WAIT_MS;
    while (saving() && Date.now() < until && !disposed) await sleep(150);
    const thread = session.state().threads.find((t) => t.id === threadId) ?? null;
    // Before a save lands the rows carry the file's fingerprint as their document id (R67): the reply then stays in this tab.
    const documentId = thread?.documentId ?? storedDocumentId();
    if (documentId !== null && session.state().mode === 'stored') await readFlags(documentId);
    const p = privacyNow(documentId);
    return { reason: p.reason, documentId, saved: p.saved };
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
    const r = running.get(id);
    if (r) return r.abort.abort('removed' satisfies AbortReason);
    void storeReady.then(() => store?.discardDraft(id)).catch((e: unknown) => log(e, 'discard'));
  };

  /** Runs one turn, after any turn still running in the same thread (a follow-up waits for the answer before it). */
  function start(o: { threadId: ThreadId; questionId: CommentId; replyId: CommentId; role: ModelRole; preset?: 'explain-figure' | 'whole-document'; skip?: CommentId[] }): void {
    const prev = queues.get(o.threadId) ?? Promise.resolve();
    const job = prev.then(async () => {
      if (disposed) return;
      const s = await settle(o.threadId);
      if (s.reason !== null || s.documentId === null) {
        host.showNote(PRIVATE_MESSAGES[s.reason ?? 'unsaved']);
        return;
      }
      const thread = threadOf(o.threadId);
      if (!thread) return;
      const abort = new AbortController();
      running.set(o.replyId, { abort, threadId: o.threadId });
      if (o.preset) presets.set(o.replyId, o.preset);
      const documentId = s.documentId;
      const saved = s.saved;
      const runner = createTurnRunner({
        client: createClaudeClient,
        context: contextFor(documentId, saved),
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
        // Asked again right before anything leaves (a Forget in another tab, "Never save this file" while the owner answered).
        privacy: () => {
          const now = privacyNow(documentId);
          // A PDF that was not sure and got saved meanwhile is the same PDF the owner chose to send: its rows still carry the fingerprint.
          if (!saved && now.reason === 'unsaved' && host.save?.state.kind === 'saved') return null;
          return now.reason;
        },
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
        ...(o.preset ? { preset: o.preset } : {}),
        ...(o.skip ? { skip: o.skip } : {}),
      };
      try {
        const meta: ClaudeReplyMeta = await runner.run(req, () => undefined, abort.signal);
        if (meta.error?.code === 'no-key') refreshKey();
      } finally {
        running.delete(o.replyId);
        const pack = runner.lastPack(o.threadId);
        if (pack) packs.set(o.threadId, pack);
      }
    });
    const tail = job.catch((e: unknown) => log(e, 'turn'));
    queues.set(o.threadId, tail);
    void tail.then(() => {
      if (queues.get(o.threadId) === tail) queues.delete(o.threadId);
    });
  }

  /** The owner's latest sent note in the thread: the question. */
  const lastQuestion = (threadId: ThreadId): CommentRow | null =>
    commentsOf(threadId).filter((c) => c.author === 'me' && c.draftOfTab === null && c.body.trim() !== '').sort((a, b) => a.createdAt - b.createdAt).at(-1) ?? null;

  // Contract §3 step 5, once the saved PDF's notes are in: replies left half-written by a tab that is gone become "interrupted".
  void (async () => {
    await session.ready.catch(() => undefined);
    await storeReady;
    const until = Date.now() + 15_000;
    while (!disposed && session.state().mode !== 'stored' && Date.now() < until) await sleep(250);
    if (disposed || session.state().mode !== 'stored') return;
    await rows.sweep((id) => running.has(id), onRemoveFor).catch((e: unknown) => log(e, 'sweep'));
  })();

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
      start({ threadId: row.threadId, questionId: question, replyId, role: meta.role ?? 'default', ...(preset ? { preset } : {}) });
    },

    thinkHarder(threadId, replyId) {
      const row = rowOf(replyId);
      const meta = row && isClaudeMeta(row.meta) ? row.meta : null;
      const question = meta?.questionId ?? lastQuestion(threadId)?.id ?? null;
      if (question === null) return;
      const preset = presets.get(replyId) ?? (meta?.scope === 'whole-document' ? 'whole-document' : undefined);
      start({ threadId, questionId: question, replyId: newId<CommentId>(), role: 'think-harder', skip: [replyId], ...(preset ? { preset } : {}) });
    },

    model(role) {
      if (settings === null) void loadSettings().catch(() => undefined);
      const m = settings?.models[role] ?? null;
      return m ? { displayName: m.displayName } : null;
    },

    thinkHarderUsd(threadId) {
      const pack = packs.get(threadId) ?? null;
      const model = settings?.models['think-harder'] ?? null;
      if (!pack || !model) return null;
      return estimate(pack, 'think-harder', model, { webSearch: settings?.webSearch === true && model.webSearchTool !== null }).usd;
    },

    privacy: () => privacyNow(storedDocumentId()).reason,
    running: (id) => running.has(id),

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const r of running.values()) r.abort.abort('stop' satisfies AbortReason);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
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
export const claudeTabHost: ClaudeUiHost = {
  ask: (target, o) => claudeEntry.get()?.ask(target, o) ?? Promise.resolve('threadId' in target ? target.threadId : ('' as ThreadId)),
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
