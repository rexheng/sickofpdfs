// The reply status (plan §4 F): what Claude is doing right now, in one quiet line under the words, with Stop.
//
// "Reading 4 passages…", "Searching the web for “parallel trends”…", "Writing…". It shows only in the tab that runs the
// reply, because only that tab can stop it. Two more (R105, TB6): "Getting ready…" while the first question in a paper starts
// the local search, and "Waiting for you to confirm…" while a confirm dialog asks, with no Stop (nothing is sent until Send). The words come from the live stream (`claudeLive`), which the runner feeds
// with the same ClaudeStreamEvents it gets from the stream mapper. The reply row in the store is written at most every
// 500 ms (contract §3), so the live text here lets the words grow smoothly in between; the row stays the record.
import type { ClaudeStreamEvent, CommentId, PageCitation, ReplyError, WebSource } from '@sop/core';
import { Icon } from '@sop/ui';
import { useCallback, useSyncExternalStore } from 'react';
import styles from './ReplyStatus.module.css';

/** What a reply is doing, as this tab sees it while it runs. */
export interface ReplyLive {
  phase: 'pending' | 'streaming' | 'done' | 'error';
  /** The status line's words, or null when there is nothing to say. */
  label: string | null;
  /** A tool is running now (a search on the web or in the PDF): the line says so until it is done. */
  toolRunning: boolean;
  /** Every text delta so far, in order: the reply's Markdown body as it grows. */
  text: string;
  citations: PageCitation[];
  webSources: WebSource[];
  error: ReplyError | null;
}

/** What the request holds, so the first line can say what Claude is reading before any words come. */
export interface ReplyContext {
  /** Passages sent with the question (the focus paragraph counts as one). */
  passages?: number;
  /** Figure labels sent with the question ("Figure 3"). */
  figures?: readonly string[];
  scope?: 'passages' | 'whole-document';
  /** Pages, for the whole document. */
  pages?: number;
  /** The first question in this paper: the local search starts first (it takes a few seconds), so the line says so. */
  preparing?: boolean;
}

/** While a confirm dialog asks (R105). The reply shows no Stop then: nothing is sent, and the dialog is the way out. */
export const WAITING_LABEL = 'Waiting for you to confirm…';
/** The first question in a paper, while the local search starts. */
export const PREPARING_LABEL = 'Getting ready…';

const live = new Map<CommentId, ReplyLive>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const cb of [...listeners]) cb();
};

/** "Reading 4 passages…", "Looking at Figure 3…", "Reading all 12 pages…". */
export function readingLabel(c: ReplyContext | undefined): string {
  if (c?.preparing === true) return PREPARING_LABEL;
  if (c?.scope === 'whole-document') return c.pages ? `Reading all ${c.pages} pages…` : 'Reading the whole document…';
  const figures = c?.figures ?? [];
  if (figures.length === 1) return `Looking at ${figures[0]}…`;
  if (figures.length > 1) return `Looking at ${figures.slice(0, -1).join(', ')} and ${figures.at(-1)}…`;
  const n = c?.passages ?? 0;
  if (n === 1) return 'Reading 1 passage…';
  if (n > 1) return `Reading ${n} passages…`;
  return 'Reading…';
}

const WRITING = 'Writing…';

/**
 * The live stream of this tab's replies. The runner (slice D) calls `begin` when it has built the request, `feed` with
 * every stream event, and `end` once the final row is written. Nothing here is stored or sent anywhere.
 */
export const claudeLive = {
  begin: (replyId: CommentId, context?: ReplyContext): void => {
    live.set(replyId, { phase: 'pending', label: readingLabel(context), toolRunning: false, text: '', citations: [], webSources: [], error: null });
    notify();
  },
  feed: (replyId: CommentId, e: ClaudeStreamEvent): void => {
    const was = live.get(replyId) ?? { phase: 'pending', label: readingLabel(undefined), toolRunning: false, text: '', citations: [], webSources: [], error: null };
    const next: ReplyLive = { ...was };
    switch (e.type) {
      case 'status':
        next.phase = e.status;
        if (e.status === 'streaming' && !was.toolRunning && was.text !== '') next.label = WRITING;
        break;
      case 'text':
        next.phase = 'streaming';
        next.text = was.text + e.delta;
        if (!was.toolRunning) next.label = WRITING;
        break;
      case 'citation':
        next.citations = [...was.citations.filter((c) => c.n !== e.citation.n), e.citation];
        break;
      case 'web-source':
        next.webSources = [...was.webSources.filter((s) => s.n !== e.source.n), e.source];
        break;
      case 'tool':
        next.toolRunning = e.state === 'running';
        next.label = e.state === 'running' ? e.label : WRITING;
        break;
      case 'done':
        next.phase = 'done';
        next.label = null;
        next.toolRunning = false;
        break;
      case 'error':
        next.phase = 'error';
        next.error = e.error;
        next.label = null;
        next.toolRunning = false;
        break;
    }
    live.set(replyId, next);
    notify();
  },
  /** A confirm dialog asks now: "Waiting for you to confirm…" until the answer (then `begin` again says what is read). */
  waiting: (replyId: CommentId): void => {
    const was = live.get(replyId) ?? { phase: 'pending' as const, label: null, toolRunning: false, text: '', citations: [], webSources: [], error: null };
    live.set(replyId, { ...was, phase: 'pending', label: WAITING_LABEL });
    notify();
  },
  /** The final row is written: the row is the record from now on. */
  end: (replyId: CommentId): void => {
    if (live.delete(replyId)) notify();
  },
  get: (replyId: CommentId): ReplyLive | null => {
    return live.get(replyId) ?? null;
  },
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

/** This tab's live view of a reply, or null when this tab is not running it. */
export function useReplyLive(replyId: CommentId): ReplyLive | null {
  const get = useCallback(() => claudeLive.get(replyId), [replyId]);
  return useSyncExternalStore(claudeLive.subscribe, get, get);
}

export interface ReplyStatusProps {
  /** The words: "Reading 4 passages…", "Searching the web for …". */
  label: string;
  /** Stop. Without it (another tab runs the reply) there is no button. */
  onStop?: () => void;
}

/**
 * One quiet line under a reply that is being written: three breathing dots in Claude's colour, the words, and Stop at
 * the right. It is a polite live region, so a screen reader hears each new step once.
 */
export function ReplyStatus({ label, onStop: stop }: ReplyStatusProps) {
  // While a dialog asks, nothing is being sent: there is nothing to stop (R105).
  const onStop = label === WAITING_LABEL ? undefined : stop;
  return (
    <div className={styles.status}>
      <span className={styles.dots} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className={styles.label} role="status" aria-live="polite">
        {label}
      </span>
      {onStop !== undefined && (
        <button
          type="button"
          className={styles.stop}
          onClick={(event) => {
            event.stopPropagation();
            onStop();
          }}
        >
          <Icon name="stop" size={20} filled className={styles.stopIcon} />
          <span>Stop</span>
        </button>
      )}
    </div>
  );
}
