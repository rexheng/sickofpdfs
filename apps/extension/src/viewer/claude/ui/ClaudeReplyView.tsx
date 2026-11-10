// A reply from Claude in a Docs-style card (plan §4 F; §8 A4: the card draws an `author 'claude'` comment with
// ClaudeReplyView({ thread, comment })). It sits under CommentItem's avatar, name and time, in place of the body.
//
// What it shows, by the reply row's `meta.status` (contract §3) and, in the tab that runs it, the live stream:
// - pending: "Reading 4 passages…" with three dots, and Stop.
// - streaming: the words as they come, with a caret, then the status line ("Searching the web for …") and Stop.
// - done: the answer with its chips: "Page 4" (jumps and lights the cited sentence), the site of a web source (opens a
//   new tab), and "Figure 3 · Page 5" for a figure (jumps and selects it). Under the newest everyday answer of the thread,
//   Think harder. R107: a card never shows the model's name or what an answer cost (that is in Settings → Claude, and in
//   the ask-first dialog when a question costs more than the owner's limit).
// - error: the text so far stays, then one plain sentence and the buttons that help: Try again, Open Settings; Ask again
//   after Cancel or Stop; Ask again with more room for an answer cut short; OK for a private PDF's refusal (R105).
// A Think harder answer says so at its top, in plain words: "Thought harder".
//
// Normal text never scrolls sideways (R107): it wraps anywhere it must (Chinese and Japanese between any two characters, a
// long web address or word wherever it has to). Only a wide formula or a code block scrolls, inside its own box.
//
// The body is Claude's Markdown, drawn as React elements only. Links are limited to `cite:`, `web:` and https (plan
// §4 F): any other address keeps its words and loses its link. Repeated chips for one page, or one source, with only
// spaces or commas between them are drawn once (contracts §6 leaves merging to the UI); the stored body keeps every one.
// A chip stays on the line of the word before it, so it reads as the citation of its sentence, never as the start of the
// next one. Maths (`$…$`, `$$…$$`) is drawn with KaTeX (ClaudeMaths.tsx).
//
// The library's Notes page and Home draw replies with this same view (LibraryClaudeReply below), so a reply reads the
// same everywhere, maths included. There the chips open the note's reading instead of jumping in it.
import type { ClaudeReplyMeta, CommentRow, PageCitation, ReplyError, ThreadRow, WebSource } from '@sop/core';
import { type Block, type CommentView, Icon, type Inline, parseMarkdown, TextButton } from '@sop/ui';
import { Fragment, type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CitationChip, ReplyChipPlace, type ReplyChipPlaceValue } from './CitationChip';
import { extractMaths, MathView, type MathSpan, splitMaths } from './ClaudeMaths';
import styles from './ClaudeReplyView.module.css';
import { FigureChip } from './FigureChip';
import { claudeUi, type ClaudeUiHost, openClaudeSettings, useClaudeUi } from './host';
import { figurePageOf } from './jump-target';
import { readingLabel, ReplyStatus, useReplyLive } from './ReplyStatus';
import { SourceChip } from './SourceChip';
import { ThinkHarderButton } from './ThinkHarderButton';

export interface ClaudeReplyViewProps {
  /** The thread the reply is in: its id (for Think harder) and its anchor (a figure note's figure). */
  thread: Pick<ThreadRow, 'id' | 'anchor'>;
  comment: CommentView;
  /** The thread's comments, oldest first: Think harder shows only on the newest everyday answer. */
  comments?: readonly CommentView[];
}

/** The parts of `meta` this view reads; a reply written before Phase 4 (or by claude.ai) may lack some. */
type Meta = Partial<ClaudeReplyMeta> & {
  /** R105: the owner pressed Cancel in the ask-first dialog; nothing was sent (turn.ts). */
  notSent?: boolean;
  /** The length limit stopped the answer; asking again gives it more room (turn.ts). */
  cutShort?: boolean;
};

/** Which buttons an error offers. A setting to fix comes first; Try again then runs the same reply again. */
const SETTINGS_ERRORS = new Set<ReplyError['code']>(['no-key', 'bad-key', 'no-model', 'over-cap']);
const NO_RETRY = new Set<ReplyError['code']>(['refused']);
/** Not a fault, so not in red: Claude declined, or the owner stopped the reply. */
const CALM = new Set<ReplyError['code']>(['refused', 'cancelled']);

const GENERIC_ERROR = 'Claude stopped before it finished. Press Try again.';

export function ClaudeReplyView({ thread, comment, comments }: ClaudeReplyViewProps) {
  const meta = comment.meta as Meta;
  const host = useClaudeUi();
  const live = useReplyLive(comment.id);
  const rowStatus = meta.status ?? 'done';
  // The live stream leads while the row is still being written (at most every 500 ms); once the row is final, it is
  // the record.
  const leading = live !== null && (rowStatus === 'pending' || rowStatus === 'streaming');
  const status: ClaudeReplyMeta['status'] = leading ? live.phase : rowStatus;
  const body = leading && live.text.length >= comment.body.length ? live.text : comment.body;
  const error = status === 'error' ? (meta.error ?? live?.error ?? null) : null;

  const citations = useMemo(() => byNumber(meta.citations, live?.citations), [meta.citations, live?.citations]);
  const sources = useMemo(() => byNumber(meta.webSources, live?.webSources), [meta.webSources, live?.webSources]);
  const figures = meta.figureLabels ?? [];
  // This tab writes the reply: it has the live stream, or the row says so (`draftOfTab`, contract §3). Only then can it stop.
  const own = claudeUi.tab();
  const inThisTab = live !== null || (own !== null && comment.draftOfTab === own);
  const running = status === 'pending' || status === 'streaming';
  const stop = inThisTab && running && host?.stop !== undefined ? () => host.stop?.(comment.id) : undefined;
  const label = live?.label ?? (!inThisTab ? ELSEWHERE : status === 'pending' || body === '' ? readingLabel(undefined) : WRITING);
  const harder = meta.role === 'think-harder' ? <ThoughtHarder /> : null;

  if (status === 'pending' || (status === 'streaming' && body === '')) {
    return (
      <div className={styles.reply} data-claude-status={status}>
        {harder}
        <ReplyStatus label={label} onStop={stop} />
      </div>
    );
  }

  return (
    <div className={styles.reply} data-claude-status={status}>
      {harder}
      {body !== '' && <ClaudeMarkdown source={body} citations={citations} sources={sources} streaming={status === 'streaming'} />}
      {figures.length > 0 && (
        <div className={styles.figures}>
          {figures.map((label) => (
            <FigureChip key={label} label={label} pageIndex={figurePageOf(label, thread)} />
          ))}
        </div>
      )}
      {status === 'streaming' && <ReplyStatus label={label} onStop={stop} />}
      {status === 'error' && <ErrorBlock error={error} meta={meta} host={host} replyId={comment.id} />}
      {(status === 'done' || error?.code === 'refused') && <Footer meta={meta} host={host} thread={thread} comment={comment} comments={comments} />}
    </div>
  );
}

/** A reply that another tab is writing (only that tab can stop it). */
const ELSEWHERE = 'Claude is writing this in another tab…';
const WRITING = 'Writing…';

function byNumber<T extends { n: number }>(a: readonly T[] | undefined, b: readonly T[] | undefined): ReadonlyMap<number, T> {
  const out = new Map<number, T>();
  for (const x of b ?? []) out.set(x.n, x);
  for (const x of a ?? []) out.set(x.n, x); // the row wins
  return out;
}

/** "Thought harder" at the top of a Think harder answer (TB6, visual 9 and experience 13), in the 12/16 of the time under a name. */
function ThoughtHarder() {
  return (
    <p className={styles.harder}>
      <Icon name="psychology" size={20} className={styles.harderIcon} />
      <span>Thought harder</span>
    </p>
  );
}

/**
 * The sentence of a reply that did not end in an answer, and the buttons that help (R105):
 * - a real error: Try again (and Open Settings when a setting is the fix);
 * - Cancel in the ask-first dialog, or Stop: "Ask again", in the calm colour: nothing went wrong;
 * - an answer cut short by the length limit: "Ask again with more room", calm too;
 * - "Claude doesn't read this PDF" on a private PDF: a plain OK, which takes the row away. Until then it stays.
 */
function ErrorBlock({ error, meta, host, replyId }: { error: ReplyError | null; meta: Meta; host: ClaudeUiHost | null; replyId: CommentRow['id'] }) {
  const place = useContext(ReplyChipPlace);
  const code = error?.code ?? null;
  const cut = meta.cutShort === true;
  const settings = code !== null && SETTINGS_ERRORS.has(code);
  const retry = host?.retry !== undefined && (code === null || !NO_RETRY.has(code));
  const again = cut ? 'Ask again with more room' : code === 'cancelled' || meta.notSent === true ? 'Ask again' : 'Try again';
  // A private PDF's refusal is the runner's row (no model): Claude never saw the question. A refusal by Claude has its model.
  const dismiss = code === 'refused' && (meta.role ?? null) === null ? claudeReplyDismiss.get() : null;
  const calm = cut || (code !== null && CALM.has(code));
  return (
    <div className={styles.error} role="alert">
      <p className={calm ? `${styles.errorText} ${styles.calm}` : styles.errorText}>{error?.message ?? GENERIC_ERROR}</p>
      {(settings || retry || dismiss !== null) && (
        <div className={styles.errorActions}>
          {settings && <TextButton label="Open Settings" variant="tonal" onClick={place.openSettings ?? openClaudeSettings} />}
          {retry && <TextButton label={again} icon="refresh" className={settings ? undefined : styles.flush} onClick={() => host?.retry?.(replyId)} />}
          {dismiss !== null && <TextButton label="OK" className={styles.flush} onClick={() => dismiss(replyId)} />}
        </div>
      )}
    </div>
  );
}

/** Takes a reply row away from its thread, as ⋮ → Delete reply does. The Claude feature sets it for the open document. */
let dismissRow: ((replyId: CommentRow['id']) => void) | null = null;
export const claudeReplyDismiss = {
  set(fn: ((replyId: CommentRow['id']) => void) | null): void {
    dismissRow = fn;
  },
  get(): ((replyId: CommentRow['id']) => void) | null {
    return dismissRow;
  },
};

/** Under a finished reply: Think harder, under the newest everyday answer of the thread only. */
function Footer({ meta, host, thread, comment, comments }: { meta: Meta; host: ClaudeUiHost | null; thread: ClaudeReplyViewProps['thread']; comment: CommentView; comments: readonly CommentView[] | undefined }) {
  const list = comments ?? [];
  const offer = host?.thinkHarder !== undefined && (meta.role ?? null) === 'default' && isNewestEveryday(comment, list) && !answeredHarder(comment, list);
  if (!offer) return null;
  const busy = list.some((c) => c.author === 'claude' && isRunning(c.meta as Meta));
  return (
    <div className={styles.footer}>
      <ThinkHarderButton disabled={busy} onClick={() => host?.thinkHarder?.(thread.id, comment.id)} />
    </div>
  );
}

const isRunning = (m: Meta) => m.status === 'pending' || m.status === 'streaming';

/** No everyday answer from Claude comes after this one in the thread (one being written counts): Think harder goes here. */
function isNewestEveryday(comment: CommentView, list: readonly CommentView[]): boolean {
  const at = list.findIndex((c) => c.id === comment.id);
  if (at < 0) return true;
  return !list.slice(at + 1).some((c) => c.author === 'claude' && (c.meta as Meta).role === 'default');
}

/** A Think harder reply to the same question already follows this one: the button has done its job. */
function answeredHarder(comment: CommentView, list: readonly CommentView[]): boolean {
  const at = list.findIndex((c) => c.id === comment.id);
  const question = (comment.meta as Meta).questionId ?? null;
  return list.slice(at + 1).some((c) => {
    const m = c.meta as Meta;
    return c.author === 'claude' && m.role === 'think-harder' && (question === null || m.questionId === question);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The library's Notes page and Home
// ---------------------------------------------------------------------------------------------------------------------

export interface LibraryClaudeReplyProps {
  /** The note the reply is on (a figure note's chip names its figure's page). */
  thread: Pick<ThreadRow, 'id' | 'anchor'>;
  comment: CommentView;
  /** Opens the note's reading, at the note: what a page or figure chip does here. */
  onOpenReading(this: void): void;
  /** Settings → Claude, in this library tab. */
  onOpenSettings(this: void): void;
  /** Home's short card: at most 4 lines, then "Show more" (as CommentItem clamps the owner's notes). */
  clamp?: boolean;
  onShowMore?(this: void): void;
}

/**
 * A reply from Claude on a note card in the library (TB6, student 3): the same view as in the viewer, so Markdown and maths
 * read the same. Nothing here can run a reply, so there is no Stop, Try again or Think harder; a chip opens the note's
 * reading (where it jumps), and a web source opens as it does in the viewer.
 */
export function LibraryClaudeReply({ thread, comment, onOpenReading, onOpenSettings, clamp = false, onShowMore }: LibraryClaudeReplyProps) {
  const place = useMemo<ReplyChipPlaceValue>(() => ({ openReading: onOpenReading, openSettings: onOpenSettings }), [onOpenReading, onOpenSettings]);
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!clamp || el === null) {
      setOverflows(false);
      return;
    }
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, [clamp, comment.body]);
  return (
    <ReplyChipPlace.Provider value={place}>
      <div ref={box} className={clamp ? styles.clamped : undefined}>
        <ClaudeReplyView thread={thread} comment={comment} />
      </div>
      {clamp && overflows && (
        <button
          type="button"
          className={styles.showMore}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            onShowMore?.();
          }}
        >
          Show more
        </button>
      )}
    </ReplyChipPlace.Provider>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The body: Claude's Markdown, with chips
// ---------------------------------------------------------------------------------------------------------------------

interface BodyContext {
  citations: ReadonlyMap<number, PageCitation>;
  sources: ReadonlyMap<number, WebSource>;
  /** The reply's formulas, by the number their placeholder carries (ClaudeMaths.tsx). */
  maths: readonly MathSpan[];
}

/** A chip as Markdown read it, plus the citations merged into it (other passages of the same page). */
type ChipNode = Extract<Inline, { t: 'chip' }> & { also?: readonly number[] };

function ClaudeMarkdown({ source, citations, sources, streaming }: { source: string; citations: BodyContext['citations']; sources: BodyContext['sources']; streaming: boolean }) {
  // The maths comes out first, so Markdown never reads a formula's `_`, `*` or `\{` as its own.
  const { blocks, maths } = useMemo(() => {
    const m = extractMaths(source);
    return { blocks: parseMarkdown(m.text), maths: m.maths };
  }, [source]);
  const merged = useMemo(() => blocks.map((b) => mergeChips(b, (n) => citations.get(n)?.pageIndex ?? null)), [blocks, citations]);
  const ctx: BodyContext = { citations, sources, maths };
  const tail = streaming ? <span className={styles.caret} aria-hidden="true" /> : undefined;
  return (
    <div className={styles.body} aria-busy={streaming ? 'true' : undefined}>
      {merged.map((block, i) => renderBlock(block, i, ctx, i === merged.length - 1 ? tail : undefined))}
      {merged.length === 0 && tail}
    </div>
  );
}

/** Between two chips only this: spaces, or a comma or semicolon ("[Page 4], [Page 4]"). */
const CHIP_GAP = /^[\s,;]*$/u;

/**
 * Two chips for the same page, or the same source, with only a gap between them are drawn once (student 4). Page chips
 * of different passages on one page merge too; the chip keeps them all, so its jump can light the best of them.
 */
export function mergeChips(block: Block, pageOf: (n: number) => number | null): Block {
  const same = (a: ChipNode, b: ChipNode): boolean => {
    if (a.kind !== b.kind) return false;
    if (a.n === b.n) return true;
    if (a.kind !== 'cite') return false;
    const pa = pageOf(a.n);
    return pa !== null && pa === pageOf(b.n);
  };
  const inline = (nodes: Inline[]): Inline[] => {
    const out: Inline[] = [];
    for (const node of nodes) {
      const n: Inline = 'c' in node ? { ...node, c: inline(node.c) } : node;
      if (n.t === 'chip') {
        // the last chip, skipping a gap after it
        let j = out.length - 1;
        while (j >= 0 && out[j]?.t === 'text' && CHIP_GAP.test((out[j] as { v: string }).v)) j--;
        const prev = out[j];
        if (prev?.t === 'chip' && same(prev, n)) {
          const p: ChipNode = prev;
          const known = n.n === p.n || p.also?.includes(n.n) === true;
          out[j] = known ? p : { ...p, also: [...(p.also ?? []), n.n] };
          out.length = j + 1;
          continue;
        }
      }
      out.push(n);
    }
    return out;
  };
  switch (block.t) {
    case 'p':
    case 'h':
      return { ...block, c: inline(block.c) };
    case 'ul':
    case 'ol':
      return { ...block, items: block.items.map(inline) };
    case 'quote':
      return { ...block, c: block.c.map((b) => mergeChips(b, pageOf)) };
    case 'pre':
      return block;
  }
}

function renderBlock(block: Block, key: number, ctx: BodyContext, tail: ReactNode): ReactNode {
  switch (block.t) {
    case 'p':
    case 'h':
      return (
        <p key={key} className={block.t === 'h' ? `${styles.p} ${styles.h}` : styles.p}>
          {renderInline(block.c, ctx)}
          {tail}
        </p>
      );
    case 'ul':
    case 'ol': {
      const items = block.items.map((item, i) => (
        <li key={i}>
          {renderInline(item, ctx)}
          {i === block.items.length - 1 && tail}
        </li>
      ));
      return block.t === 'ul' ? (
        <ul key={key} className={styles.list}>
          {items}
        </ul>
      ) : (
        <ol key={key} className={styles.list} start={block.start}>
          {items}
        </ol>
      );
    }
    case 'quote':
      return (
        <blockquote key={key} className={styles.quote}>
          {block.c.map((inner, i) => renderBlock(inner, i, ctx, i === block.c.length - 1 ? tail : undefined))}
        </blockquote>
      );
    case 'pre':
      return (
        <Fragment key={key}>
          <pre className={styles.pre}>
            <code>{block.v}</code>
          </pre>
          {tail}
        </Fragment>
      );
  }
}

/**
 * Words with the formulas put back in place of their placeholders. Punctuation right after an inline formula stays on
 * its line ("…= 1]," never wraps the comma alone onto the next line).
 */
function withMaths(text: string, ctx: BodyContext): ReactNode {
  if (ctx.maths.length === 0) return text;
  const parts = splitMaths(text);
  const out: ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (typeof part === 'string') {
      out.push(<Fragment key={i}>{part}</Fragment>);
      continue;
    }
    const m = ctx.maths[part];
    if (m === undefined) continue;
    const after = parts[i + 1];
    // Only a short formula: a long one must still be able to break across lines.
    const stick = !m.display && m.tex.length <= SHORT_TEX && typeof after === 'string' ? (/^[,.;:!?)\]]+/u.exec(after)?.[0] ?? '') : '';
    out.push(
      stick === '' ? (
        <MathView key={i} tex={m.tex} display={m.display} />
      ) : (
        <span key={i} className={styles.together}>
          <MathView tex={m.tex} display={false} />
          {stick}
        </span>
      ),
    );
    if (stick !== '') parts[i + 1] = (after as string).slice(stick.length);
  }
  return out;
}

/** An inline formula this long or shorter may sit on one line with what follows it. */
const SHORT_TEX = 40;

/** Only https links keep their target (plan §4 F); anything else is drawn as its words. */
const HTTPS = /^https:\/\//iu;

/** The words of some inline nodes, for finding the sentence a chip cites (formulas left out). */
function plainOf(nodes: readonly Inline[]): string {
  return nodes.map((n) => ('v' in n ? n.v : 'c' in n ? plainOf(n.c) : n.t === 'br' ? ' ' : '')).join('');
}
const withoutMaths = (s: string) => s.replace(/\d+/gu, ' ');

/** The last sentence of `before` (the words a chip follows), or the first of `after` when nothing comes before it. */
export function citedSentence(before: string, after: string): string {
  const b = withoutMaths(before).replace(/\s+/gu, ' ').trim();
  if (b !== '') {
    const body = b.replace(/[.!?:;]+["”’)]*$/u, '');
    const cut = Math.max(body.lastIndexOf('. '), body.lastIndexOf('? '), body.lastIndexOf('! '));
    return (cut >= 0 ? body.slice(cut + 2) : body).trim();
  }
  const a = withoutMaths(after).replace(/\s+/gu, ' ').trim();
  return (/^[^.!?]*/u.exec(a)?.[0] ?? a).trim();
}

/** The word before a chip, glued to it with no break; a long one (a web address) is left alone. */
const GLUE_MAX = 32;

/** Scripts written without spaces between words, where a line may break between almost any two characters. */
const NO_SPACES = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
const WORDS = new Intl.Segmenter(undefined, { granularity: 'word' });

/**
 * The word before a chip, and where it starts in `text`: the last run of text with no space in it, as in "solve.". In
 * Chinese, Japanese or Thai a whole sentence is one such run, and gluing all of it to the chip made a line wider than the
 * card, which then scrolled sideways (R107): there only its last word goes with the chip ("机制。", not the sentence).
 */
function wordBeforeChip(text: string): { at: number; word: string } | null {
  const m = /(\S+)\s*$/u.exec(text);
  if (m === null) return null;
  const run = m[1];
  if (!NO_SPACES.test(run)) return { at: m.index, word: run };
  let start = -1;
  for (const seg of WORDS.segment(run)) if (seg.isWordLike === true) start = seg.index;
  if (start < 0) start = 0;
  return { at: m.index + start, word: run.slice(start) };
}

/**
 * Inline nodes as React elements. A chip, or a run of chips with only spaces between them, goes in one unbreakable box
 * with the word before it, so the chips end their sentence's line instead of starting the next one (student 4).
 */
function renderInline(nodes: Inline[], ctx: BodyContext): ReactNode[] {
  const out: ReactNode[] = [];
  // The words since the last chips: the sentence the next chip cites.
  let since: Inline[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.t !== 'chip') {
      out.push(renderNode(node, i, ctx));
      since.push(node);
      continue;
    }
    const run: ChipNode[] = [node];
    while (i + 1 < nodes.length) {
      const a = nodes[i + 1];
      const b = nodes[i + 2];
      if (a?.t === 'chip') {
        run.push(a);
        i += 1;
      } else if (a?.t === 'text' && a.v.trim() === '' && b?.t === 'chip') {
        run.push(b);
        i += 2;
      } else break;
    }
    // The word before: taken off the text drawn just now, and drawn again inside the span with the chips.
    let lead = '';
    const prev = since.at(-1);
    if (prev?.t === 'text' && out.length > 0) {
      const m = wordBeforeChip(prev.v);
      const word = m?.word ?? '';
      const longMaths = splitMaths(word).some((p) => typeof p === 'number' && (ctx.maths[p]?.tex.length ?? 0) > SHORT_TEX);
      if (m !== null && word.length <= GLUE_MAX && !longMaths) {
        lead = word;
        out[out.length - 1] = <Fragment key={`${i}-before`}>{withMaths(prev.v.slice(0, m.at), ctx)}</Fragment>;
      }
    }
    const sentence = citedSentence(plainOf(since), plainOf(nodes.slice(i + 1)));
    out.push(
      <span key={i} className={styles.cited}>
        {lead !== '' && withMaths(lead, ctx)}
        {run.map((chip, k) => renderChip(chip, k, ctx, sentence))}
      </span>,
    );
    since = [];
  }
  return out;
}

function renderChip(node: ChipNode, key: number, ctx: BodyContext, sentence: string): ReactNode {
  if (node.kind !== 'cite') return <SourceChip key={key} label={node.label} source={ctx.sources.get(node.n) ?? null} />;
  const also = (node.also ?? []).map((n) => ctx.citations.get(n)).filter((c): c is PageCitation => c !== undefined);
  return <CitationChip key={key} label={node.label} citation={ctx.citations.get(node.n) ?? null} also={also} sentence={sentence} />;
}

function renderNode(node: Exclude<Inline, { t: 'chip' }>, i: number, ctx: BodyContext): ReactNode {
  switch (node.t) {
    case 'text':
      return <Fragment key={i}>{withMaths(node.v, ctx)}</Fragment>;
    case 'br':
      return <br key={i} />;
    case 'strong':
      return <strong key={i}>{renderInline(node.c, ctx)}</strong>;
    case 'em':
      return <em key={i}>{renderInline(node.c, ctx)}</em>;
    case 'del':
      return <del key={i}>{renderInline(node.c, ctx)}</del>;
    case 'code':
      return (
        <code key={i} className={styles.code}>
          {node.v}
        </code>
      );
    case 'link':
      return HTTPS.test(node.href) ? (
        <a
          key={i}
          className={styles.link}
          href={node.href}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          onClick={(event) => event.stopPropagation()}
        >
          {renderInline(node.c, ctx)}
        </a>
      ) : (
        <Fragment key={i}>{renderInline(node.c, ctx)}</Fragment>
      );
  }
}
