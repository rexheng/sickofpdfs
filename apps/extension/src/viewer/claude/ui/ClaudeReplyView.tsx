// A reply from Claude in a Docs-style card (plan §4 F; §8 A4: the card draws an `author 'claude'` comment with
// ClaudeReplyView({ thread, comment })). It sits under CommentItem's avatar, name and time, in place of the body.
//
// What it shows, by the reply row's `meta.status` (contract §3) and, in the tab that runs it, the live stream:
// - pending: "Reading 4 passages…" with three dots, and Stop.
// - streaming: the words as they come, with a caret, then the status line ("Searching the web for …") and Stop.
// - done: the answer with its chips: "Page 4" (jumps and flashes), the site of a web source (opens a new tab), and
//   "Figure 3 · Page 5" for a figure (jumps and selects it). Under it Think harder, and on hover the model and the cost.
// - error: the text so far stays, then one plain sentence and the buttons that help: Try again, Open Settings.
//
// The body is Claude's Markdown, drawn as React elements only. Links are limited to `cite:`, `web:` and https (plan
// §4 F): any other address keeps its words and loses its link. Repeated chips in a row are drawn once (contracts §6
// leaves merging to the UI); the stored body keeps every one. Maths (`$…$`, `$$…$$`) is drawn with KaTeX (ClaudeMaths.tsx).
import type { ClaudeReplyMeta, CommentRow, ModelRole, PageCitation, ReplyError, ThreadRow, WebSource } from '@sop/core';
import { type Block, type CommentView, type Inline, parseMarkdown, TextButton } from '@sop/ui';
import { Fragment, type ReactNode, useMemo } from 'react';
import { CitationChip } from './CitationChip';
import { extractMaths, MathView, type MathSpan, splitMaths } from './ClaudeMaths';
import styles from './ClaudeReplyView.module.css';
import { FigureChip } from './FigureChip';
import { claudeUi, type ClaudeUiHost, formatUsd, openClaudeSettings, useClaudeUi } from './host';
import { figurePageOf } from './jump';
import { readingLabel, ReplyStatus, useReplyLive } from './ReplyStatus';
import { SourceChip } from './SourceChip';
import { ThinkHarderButton } from './ThinkHarderButton';

export interface ClaudeReplyViewProps {
  /** The thread the reply is in: its id (for Think harder) and its anchor (a figure note's figure). */
  thread: Pick<ThreadRow, 'id' | 'anchor'>;
  comment: CommentView;
  /** The thread's comments, oldest first: Think harder shows only on the last answer to a question. */
  comments?: readonly CommentView[];
}

/** The parts of `meta` this view reads; a reply written before Phase 4 (or by claude.ai) may lack some. */
type Meta = Partial<ClaudeReplyMeta> & { modelName?: string };

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

  if (status === 'pending' || (status === 'streaming' && body === '')) {
    return (
      <div className={styles.reply} data-claude-status={status}>
        <ReplyStatus label={label} onStop={stop} />
      </div>
    );
  }

  return (
    <div className={styles.reply} data-claude-status={status}>
      {body !== '' && <ClaudeMarkdown source={body} citations={citations} sources={sources} streaming={status === 'streaming'} />}
      {figures.length > 0 && (
        <div className={styles.figures}>
          {figures.map((label) => (
            <FigureChip key={label} label={label} pageIndex={figurePageOf(label, thread)} />
          ))}
        </div>
      )}
      {status === 'streaming' && <ReplyStatus label={label} onStop={stop} />}
      {status === 'error' && <ErrorBlock error={error} host={host} replyId={comment.id} />}
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

function ErrorBlock({ error, host, replyId }: { error: ReplyError | null; host: ClaudeUiHost | null; replyId: CommentRow['id'] }) {
  const code = error?.code ?? null;
  const settings = code !== null && SETTINGS_ERRORS.has(code);
  const retry = host?.retry !== undefined && (code === null || !NO_RETRY.has(code));
  return (
    <div className={styles.error} role="alert">
      <p className={code !== null && CALM.has(code) ? `${styles.errorText} ${styles.calm}` : styles.errorText}>{error?.message ?? GENERIC_ERROR}</p>
      {(settings || retry) && (
        <div className={styles.errorActions}>
          {settings && <TextButton label="Open Settings" variant="tonal" onClick={openClaudeSettings} />}
          {retry && <TextButton label="Try again" icon="refresh" className={settings ? undefined : styles.flush} onClick={() => host?.retry?.(replyId)} />}
        </div>
      )}
    </div>
  );
}

function Footer({ meta, host, thread, comment, comments }: { meta: Meta; host: ClaudeUiHost | null; thread: ClaudeReplyViewProps['thread']; comment: CommentView; comments: readonly CommentView[] | undefined }) {
  const role = meta.role ?? null;
  const offer = host?.thinkHarder !== undefined && role === 'default' && !answeredHarder(comment, comments);
  const busy = (comments ?? []).some((c) => c.author === 'claude' && isRunning(c.meta as Meta));
  const cost = costLine(meta, host, role);
  // The cost line takes no room: it shows on hover in the gap under the reply, so replies keep Docs' spacing.
  return (
    <>
      {offer && (
        <div className={styles.footer}>
          <ThinkHarderButton
            model={host?.model?.('think-harder')?.displayName ?? null}
            usd={host?.thinkHarderUsd?.(thread.id) ?? null}
            disabled={busy}
            onClick={() => host?.thinkHarder?.(thread.id, comment.id)}
          />
        </div>
      )}
      {cost !== null && <span className={styles.cost}>{cost}</span>}
    </>
  );
}

const isRunning = (m: Meta) => m.status === 'pending' || m.status === 'streaming';

/** A Think harder reply to the same question already follows this one: the button has done its job. */
function answeredHarder(comment: CommentView, comments: readonly CommentView[] | undefined): boolean {
  const list = comments ?? [];
  const at = list.findIndex((c) => c.id === comment.id);
  const question = (comment.meta as Meta).questionId ?? null;
  return list.slice(at + 1).some((c) => {
    const m = c.meta as Meta;
    return c.author === 'claude' && m.role === 'think-harder' && (question === null || m.questionId === question);
  });
}

/** "Haiku 5.5 · 0.07¢ · 1 web search", shown on hover. Null when there is nothing to say (a claude.ai reply). */
export function costLine(meta: Meta, host: Pick<ClaudeUiHost, 'model'> | null, role: ModelRole | null): string | null {
  if (meta.via === 'connector' || role === null) return null;
  // "Claude" is already the name above the reply; the line names the model only.
  const model = (meta.modelName ?? host?.model?.(role)?.displayName ?? null)?.replace(/^claude\s+/iu, '') ?? null;
  const usage = meta.usage ?? null;
  const parts: string[] = [];
  if (model !== null) parts.push(model);
  if (usage !== null && usage.usd > 0) parts.push(formatUsd(usage.usd));
  if (usage !== null && usage.webSearches > 0) parts.push(usage.webSearches === 1 ? '1 web search' : `${usage.webSearches} web searches`);
  return parts.length === 0 ? null : parts.join(' · ');
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

function ClaudeMarkdown({ source, citations, sources, streaming }: { source: string; citations: BodyContext['citations']; sources: BodyContext['sources']; streaming: boolean }) {
  // The maths comes out first, so Markdown never reads a formula's `_`, `*` or `\{` as its own.
  const { blocks, maths } = useMemo(() => {
    const m = extractMaths(source);
    return { blocks: parseMarkdown(m.text).map(mergeChips), maths: m.maths };
  }, [source]);
  const ctx: BodyContext = { citations, sources, maths };
  const tail = streaming ? <span className={styles.caret} aria-hidden="true" /> : undefined;
  return (
    <div className={styles.body} aria-busy={streaming ? 'true' : undefined}>
      {blocks.map((block, i) => renderBlock(block, i, ctx, i === blocks.length - 1 ? tail : undefined))}
      {blocks.length === 0 && tail}
    </div>
  );
}

/** Two chips for the same page or source with only spaces between them are drawn once. */
function mergeChips(block: Block): Block {
  const inline = (nodes: Inline[]): Inline[] => {
    const out: Inline[] = [];
    for (const node of nodes) {
      const n: Inline = 'c' in node ? { ...node, c: inline(node.c) } : node;
      if (n.t === 'chip') {
        // the last chip, skipping white space after it
        let j = out.length - 1;
        while (j >= 0 && out[j]?.t === 'text' && (out[j] as { v: string }).v.trim() === '') j--;
        const prev = out[j];
        if (prev?.t === 'chip' && prev.kind === n.kind && prev.n === n.n) {
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
      return { ...block, c: block.c.map(mergeChips) };
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
    const stick = !m.display && m.tex.length <= 40 && typeof after === 'string' ? (/^[,.;:!?)\]]+/u.exec(after)?.[0] ?? '') : '';
    out.push(
      stick === '' ? (
        <MathView key={i} tex={m.tex} display={m.display} />
      ) : (
        <span key={i} className={styles.nowrap}>
          <MathView tex={m.tex} display={false} />
          {stick}
        </span>
      ),
    );
    if (stick !== '') parts[i + 1] = (after as string).slice(stick.length);
  }
  return out;
}

/** Only https links keep their target (plan §4 F); anything else is drawn as its words. */
const HTTPS = /^https:\/\//iu;

function renderInline(nodes: Inline[], ctx: BodyContext): ReactNode[] {
  return nodes.map((node, i) => {
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
      case 'chip':
        return node.kind === 'cite' ? (
          <CitationChip key={i} label={node.label} citation={ctx.citations.get(node.n) ?? null} />
        ) : (
          <SourceChip key={i} label={node.label} source={ctx.sources.get(node.n) ?? null} />
        );
    }
  });
}
