// The questions asked before Claude is sent anything that needs a yes (contracts §6 "Before sending"; plan §4 F):
// - a PDF the owner did not choose for Claude (R105): "Send 3 passages to Anthropic?". It says "This PDF is not in your library",
//   or, when a note or a mark saved it, "You haven't chosen to save this PDF yourself". It names everything that goes: when the
//   thread has earlier notes, "Your earlier notes in this thread go too." (R105b);
// - an estimate over the owner's limit for asking first ($0.25 unless changed): "This question costs about 31¢", and with
//   a $0 limit "Your limit for asking first is $0, so Claude asks before every question.";
// - "Ask about the whole document": the pages and the cost first.
//
// The runner (slice D) calls `confirmClaude` once per ask, in the order `decide` gives them, and sends nothing until it
// resolves true. Cancel, Esc and a click outside all mean no. Cancel has the focus in every one of them, however it was
// opened (a key, a click on Think harder): Enter presses Cancel, so a key typed late never sends anything (as R100 rules
// for the save question). Costs are said the one way (cost-words.ts).
import { Dialog } from '@sop/ui';
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import styles from './ClaudeConfirmDialog.module.css';
import { amountWords, costWords } from './cost-words';

export type ClaudeAsk = 'unsaved' | 'over-threshold' | 'whole-document';

export interface ClaudeConfirmRequest {
  ask: ClaudeAsk;
  /** About what the question costs, in dollars (the estimate). */
  usd: number;
  /** What would be sent from a PDF that is not saved: passages (the marked one counts) and figures. */
  passages?: number;
  figures?: number;
  /** The document's pages, for the whole document. */
  pages?: number;
  /** The model that would answer ("Claude Haiku 5.5"). */
  model?: string | null;
  /** The owner's "ask first above" amount (claude.confirmOverUsd), in dollars. */
  thresholdUsd?: number | null;
  /**
   * R105, "unsaved": the PDF is in the library, but a note or a mark saved it, not the owner. The dialog then says that, not
   * "This PDF is not in your library" (the chip says "Saved to library").
   */
  inLibrary?: boolean;
  /** R105b, "unsaved": the thread's earlier notes (and Claude's earlier replies) that go with the question. Left out: none. */
  earlier?: { notes: number; replies: number };
}

/** "Your earlier notes in this thread go too.": the thread goes with the question (R105b). Empty when nothing of it does. */
export function earlierWords(e: ClaudeConfirmRequest['earlier']): string {
  const notes = e?.notes ?? 0;
  if (notes <= 0) return '';
  const replies = (e?.replies ?? 0) > 0;
  if (notes === 1) return replies ? 'Your earlier note and Claude’s replies in this thread go too.' : 'Your earlier note in this thread goes too.';
  return replies ? 'Your earlier notes and Claude’s replies in this thread go too.' : 'Your earlier notes in this thread go too.';
}

/** "3 passages", "this figure", "a figure and 2 passages": what leaves the computer, counted. */
export function sentThings(r: Pick<ClaudeConfirmRequest, 'passages' | 'figures'>): string {
  const p = r.passages ?? 0;
  const f = r.figures ?? 0;
  const passages = p === 1 ? '1 passage' : `${p} passages`;
  if (f === 0) return p === 0 ? 'your question' : passages;
  const figures = f === 1 ? (p === 0 ? 'this figure' : 'a figure') : `${f} figures`;
  return p === 0 ? figures : `${figures} and ${passages}`;
}

/** The title and the plain sentences of each question. */
export function confirmWords(r: ClaudeConfirmRequest): { title: string; lines: string[]; send: string } {
  const cost = costWords(r.usd);
  const withModel = r.model ? ` with ${r.model}` : '';
  switch (r.ask) {
    case 'unsaved': {
      const what = sentThings(r);
      return {
        title: `Send ${what} to Anthropic?`,
        lines: [
          `${r.inLibrary === true ? 'You haven’t chosen to save this PDF yourself.' : 'This PDF is not in your library.'} ${
            what === 'your question' ? 'To answer, Claude needs your question.' : `To answer, Claude needs ${what} from it.`
          }`,
          // The document map always goes too (contracts §6), and so does the thread (R105b): say so, so the owner knows exactly what
          // leaves.
          ['They go to Anthropic, who run Claude, with your question and the PDF’s title, abstract and headings.', earlierWords(r.earlier), 'Nothing else is sent.'].filter(Boolean).join(' '),
          `It costs ${cost}${withModel}.`,
        ],
        send: 'Send',
      };
    }
    case 'over-threshold': {
      const limit = r.thresholdUsd != null && Number.isFinite(r.thresholdUsd) && r.thresholdUsd >= 0 ? r.thresholdUsd : null;
      return {
        title: `This question costs ${cost}`,
        lines: [
          limit === null
            ? 'That is more than usual, so you are asked first.'
            : limit === 0
              ? 'Your limit for asking first is $0, so Claude asks before every question.'
              : `Your limit for asking first is ${amountWords(limit)}. This question is over it.`,
          r.model ? `${r.model} would answer it.` : 'Claude would answer it.',
        ],
        send: 'Send',
      };
    }
    case 'whole-document':
      return {
        title: 'Ask about the whole document?',
        lines: [
          `Claude reads ${r.pages ? `all ${r.pages} pages` : 'every page'}. This costs ${cost}${withModel}.`,
          'For a question about one part, ask on that passage instead. It costs much less.',
        ],
        send: 'Send',
      };
  }
}

export interface ClaudeConfirmDialogProps {
  request: ClaudeConfirmRequest | null;
  onAnswer(this: void, yes: boolean): void;
}

/** One question at a time; `request` null closes it. */
export function ClaudeConfirmDialog({ request, onAnswer }: ClaudeConfirmDialogProps) {
  const words = request === null ? null : confirmWords(request);
  return (
    <Dialog
      open={request !== null}
      title={words?.title ?? ''}
      onOpenChange={(open) => {
        if (!open) onAnswer(false);
      }}
      actions={[
        { label: 'Cancel', onClick: () => onAnswer(false) },
        { label: words?.send ?? 'Send', primary: true, onClick: () => onAnswer(true) },
      ]}
    >
      {words?.lines.map((line) => (
        <p key={line} className={styles.line}>
          {line}
        </p>
      ))}
      {request !== null && <CancelFirst key={confirmKey(request)} />}
    </Dialog>
  );
}

/** Each question its own number, so the next one in the queue gets the focus put on its Cancel again. */
const keys = new WeakMap<ClaudeConfirmRequest, number>();
let lastKey = 0;
function confirmKey(r: ClaudeConfirmRequest): number {
  const known = keys.get(r);
  if (known !== undefined) return known;
  lastKey += 1;
  keys.set(r, lastKey);
  return lastKey;
}

/**
 * Puts the focus on Cancel once the dialog has opened. The dialog would give it to itself when opened with the pointer
 * (Think harder is clicked), where Enter then does nothing; here every question has Cancel focused, as the whole-document
 * one already had from the keyboard (TB6, experience 8). Cancel is the first action. It runs after the dialog's own
 * opening focus, which comes once this has mounted.
 */
function CancelFirst() {
  const mark = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const dialog = mark.current?.closest('[role="dialog"]');
      const cancel = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === 'Cancel');
      if (cancel !== undefined && dialog?.contains(document.activeElement) !== false) cancel.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return <span ref={mark} hidden />;
}

// ---------------------------------------------------------------------------------------------------------------------
// The one dialog of the tab, and the promise the runner waits on
// ---------------------------------------------------------------------------------------------------------------------

interface Waiting {
  request: ClaudeConfirmRequest;
  answer(yes: boolean): void;
}

const queue: Waiting[] = [];
let mounted = 0;
const listeners = new Set<() => void>();
const notify = () => {
  for (const cb of [...listeners]) cb();
};

/**
 * Asks the owner, and resolves true for Send. Resolves false for Cancel, and at once when no dialog host is mounted (no
 * viewer page is showing): nothing is ever sent without a yes. Questions asked while one is open wait their turn.
 */
export function confirmClaude(request: ClaudeConfirmRequest): Promise<boolean> {
  if (mounted === 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    queue.push({ request, answer: resolve });
    notify();
  });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const head = () => queue[0] ?? null;

/** Mounted once by the Claude feature: shows the question at the head of the queue. */
export function ClaudeConfirmHost() {
  const waiting = useSyncExternalStore(subscribe, head, head);
  // Counted while mounted, so `confirmClaude` knows someone can answer. The last one to go answers no for what waits.
  useEffect(() => {
    mounted++;
    return () => {
      mounted--;
      if (mounted === 0) while (queue.length > 0) queue.shift()?.answer(false);
    };
  }, []);
  return (
    <ClaudeConfirmDialog
      request={waiting?.request ?? null}
      onAnswer={(yes) => {
        const w = queue[0];
        if (w === undefined || w !== waiting) return;
        queue.shift();
        w.answer(yes);
        notify();
      }}
    />
  );
}
