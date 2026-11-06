import type { ClaudeReplyMeta, CommentId } from '@sop/core';
import { type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type Ref, useLayoutEffect, useRef, type WheelEvent } from 'react';
import '../../tokens/comments.css';
import { cx } from '../classes';
import type { MenuItemDef } from '../Menu';
import { AUTHOR_NAME, CommentAvatar } from './CommentAvatar';
import { CommentItem } from './CommentItem';
import { summarise } from './markdown';
import { MovedLabel, UnplacedLabel } from './MovedLabel';
import { NoteBox, ReplyBox } from './NoteBox';
import styles from './ThreadCard.module.css';
import type { CardFigure, CardPlacement, ChipLink, CommentView, NoteKept } from './types';

export interface ThreadCardProps {
  /** The sent comments, root first, in `createdAt` order. Empty for a new note whose first comment is still a draft. */
  comments: readonly CommentView[];
  /**
   * This tab's unsent text for the thread: the first comment of a new note (when `comments` is empty) or a reply.
   * `null` or absent: nothing unsent.
   */
  draft?: string | null;
  /** The clicked card: it turns light, lifts and moves 12 px left. The viewer darkens its mark at the same time. */
  active: boolean;
  /** A click or Enter on an inactive card. */
  onActivate?: () => void;
  /** Esc on the active card, outside its text boxes. */
  onDeactivate?: () => void;

  /** Typing in the note box or the reply box: pass it to `AnnotationSession.typeDraft` (it reaches `DraftKeeper`). */
  onDraftChange?: (body: string) => void;
  /** Enter, Ctrl+Enter or the button, with text. */
  onDraftSend?: (body: string) => void;
  /** Esc in the note box or the reply box. The text is not cleared: the viewer decides (spec: Esc never loses text). */
  onDraftEscape?: (body: string) => void;
  /** Blur and Esc in a box: save the draft now (`DraftKeeper.flush`). */
  onDraftFlush?: () => void;
  /** Cancel in the note box or the reply box: the unsent text is thrown away. Without it the boxes have no Cancel. */
  onDraftCancel?: () => void;

  /** The comment being edited in place, and its text. */
  editing?: { id: CommentId; body: string } | null;
  /** "Edit" in a comment's ⋮ menu. Only the owner's own comments offer it: Claude's are never rewritten. */
  onEditStart?: (id: CommentId) => void;
  onEditChange?: (body: string) => void;
  onEditSave?: (body: string) => void;
  onEditEscape?: (body: string) => void;
  /** Cancel in the edit box: the edit is thrown away and the sent text stays. */
  onEditCancel?: () => void;
  /** "Delete" in a comment's ⋮ menu. On the first comment it deletes the whole note. */
  onDelete?: (id: CommentId) => void;
  /** "Try again" on a Claude reply that stopped with an error. */
  onRetry?: (id: CommentId) => void;
  /** A citation chip in a reply was pressed. */
  onChip?: (link: ChipLink, comment: CommentId) => void;
  renderChip?: (link: ChipLink) => ReactNode;
  /** Phase 4 (A4): the content of each reply from Claude (ClaudeReplyView). Passed to every CommentItem of the thread. */
  renderClaudeReply?: (comment: CommentView) => ReactNode;
  /** Phase 4: the empty note and reply boxes' words, as Docs' "Reply or add others with @" ("Reply, or ask @Claude"). */
  notePlaceholder?: string;
  replyPlaceholder?: string;

  /** How the note sits on this copy of the PDF: 'moved' shows the quiet "Moved" label (D7). */
  placement?: CardPlacement;
  /** "Show where it was" on a moved note. */
  onShowOriginal?: () => void;
  /** One quoted line above the note: the passage it is on (the notes panel, "Couldn't place"). */
  quote?: string | null;
  /** What the note is on, when it is not a passage: "Page 4", "Whole document". Shown before the quote. */
  label?: string | null;
  /** A note on a figure: its 64 px thumbnail and label. */
  figure?: CardFigure | null;
  /** Whether the sent note is kept: the quiet sign after its first comment's time ("Saved"). Null: no sign. */
  kept?: NoteKept | null;
  /** "Try again" beside "Couldn't save". */
  onRetrySave?: () => void;

  /** Put the caret in the note box or the reply box when the card appears (a new note, a restored draft). */
  autoFocus?: boolean;
  /** "Now" for the time labels. */
  now?: number;
  id?: string;
  className?: string;
  /** For the card column, which places each card level with its mark. */
  style?: CSSProperties;
  ref?: Ref<HTMLElement>;
}

/**
 * A comment thread as a Google Docs margin card (02 section 4.11; spec "Comment cards"): 282 px wide, 12 px corners.
 * On the viewer's dark canvas an inactive card uses Drive's dark surface (#282a2c) with light text. The active card
 * turns light (#fff, Docs' shadow) and moves 12 px left; only it shows replies in full, the ⋮ menus and the reply box.
 * An inactive card shows the first comment (4 lines at most), "2 replies", and any unsent text as a draft.
 *
 * It is a controlled component: the viewer owns the comments, the draft text and which card is active.
 */
export function ThreadCard(props: ThreadCardProps) {
  const {
    comments,
    draft = null,
    active,
    onActivate,
    onDeactivate,
    placement = 'placed',
    onShowOriginal,
    quote,
    label,
    figure,
    id,
    className,
    style,
    ref,
  } = props;
  const root = comments[0];
  const replies = comments.slice(1);

  const onClick = (event: MouseEvent<HTMLElement>) => {
    // Clicks inside a portaled menu reach React ancestors too; only clicks on the card itself count.
    if (!active && event.currentTarget.contains(event.target as Node)) onActivate?.();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.target === event.currentTarget && !active && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      onActivate?.();
    } else if (event.key === 'Escape' && active && onDeactivate !== undefined) {
      event.preventDefault();
      onDeactivate();
      event.currentTarget.focus({ preventScroll: true });
    }
  };

  return (
    <article
      ref={ref}
      id={id}
      className={cx(styles.card, active && styles.active, className)}
      style={style}
      data-theme={active ? 'light' : undefined}
      data-active={active ? 'true' : 'false'}
      tabIndex={0}
      aria-label={cardName(root, replies.length, draft)}
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {placement === 'moved' && <MovedLabel onShowOriginal={onShowOriginal} revealed={active} />}
      {placement === 'unplaced' && <UnplacedLabel />}
      {figure ? <FigureRow figure={figure} /> : <ContextLine label={label ?? null} quote={quote ?? null} />}
      {root === undefined ? <NewNote {...props} draft={draft} /> : <Thread {...props} root={root} replies={replies} />}
    </article>
  );
}

/** A new note: the owner's name, "Not sent yet", and the note box (active) or the unsent text (inactive). */
function NewNote({ draft, active, autoFocus, onDraftChange, onDraftSend, onDraftEscape, onDraftFlush, onDraftCancel, notePlaceholder }: ThreadCardProps) {
  if (!active) {
    return (
      <>
        <AuthorRow time={NOT_SENT} />
        <DraftText text={draft ?? ''} />
      </>
    );
  }
  return (
    <>
      <AuthorRow time={NOT_SENT} />
      <NoteBox
        className={styles.noteBox}
        variant="note"
        placeholder={notePlaceholder}
        value={draft ?? ''}
        autoFocus={autoFocus}
        onChange={(body) => onDraftChange?.(body)}
        onSend={(body) => onDraftSend?.(body)}
        onEscape={onDraftEscape}
        onFlush={onDraftFlush}
        {...(onDraftCancel ? { onCancel: () => onDraftCancel() } : {})}
      />
    </>
  );
}

function Thread(props: ThreadCardProps & { root: CommentView; replies: CommentView[] }) {
  const { root, replies, active, draft = null, editing, now, autoFocus, onActivate, onRetry, onChip, renderChip, renderClaudeReply, kept = null, onRetrySave } = props;
  const item = (comment: CommentView, isRoot: boolean) => (
    <CommentItem
      key={comment.id}
      className={isRoot ? undefined : styles.reply}
      comment={comment}
      now={now}
      clamp={!active}
      onShowMore={onActivate}
      actions={active ? commentActions(props, comment, isRoot) : undefined}
      actionsOnHover={!isRoot}
      edit={editing?.id === comment.id ? editBox(props, editing.body) : null}
      onRetry={onRetry === undefined ? undefined : () => onRetry(comment.id)}
      onChip={onChip === undefined ? undefined : (link) => onChip(link, comment.id)}
      renderChip={renderChip}
      renderClaudeReply={renderClaudeReply}
      kept={isRoot ? kept : null}
      onRetrySave={onRetrySave}
    />
  );

  if (!active) {
    return (
      <>
        {item(root, true)}
        {replies.length > 0 && <RepliesLine replies={replies} onOpen={onActivate} />}
        {draft !== null && draft !== '' && (
          <div className={styles.replyDraft}>
            <span className={styles.draftLabel}>Reply not sent yet</span>
            <DraftText text={draft} lines={2} />
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <ThreadScroll>
        {item(root, true)}
        {replies.map((reply) => item(reply, false))}
      </ThreadScroll>
      {editing == null && (
        <ReplyBox
          className={styles.replyBox}
          placeholder={props.replyPlaceholder}
          value={draft ?? ''}
          autoFocus={autoFocus}
          onChange={(body) => props.onDraftChange?.(body)}
          onSend={(body) => props.onDraftSend?.(body)}
          onEscape={props.onDraftEscape}
          onFlush={props.onDraftFlush}
          {...(props.onDraftCancel ? { onCancel: () => props.onDraftCancel?.() } : {})}
        />
      )}
    </>
  );
}

/** How close to the end of the thread (CSS px) counts as being at its end: the newest words stay in view from there. */
const AT_END_PX = 8;
/** Keys that scroll a thread up. */
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);

/**
 * The comments of an open card (TB6). The card is at most `--sop-card-max-h` tall (the margin's view, or the notes
 * panel's list), so a long thread scrolls here, inside the card, while the reply box under it stays in view.
 * - It opens at its end, with the newest answer (and Think harder under it) in view.
 * - While it is at its end, words that arrive (a streaming answer) keep it there. Scrolling up stops that; scrolling
 *   back down to the end starts it again. (It manages this itself, so the browser's scroll anchoring is off.)
 * - A box that takes the caret here (an edit of the first note) is scrolled into view.
 * - The scroll bar takes its width from the card's right padding, so the text never moves when it appears.
 * - A soft fade at an edge says there is more past it.
 */
function ThreadScroll({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const edges = (el: HTMLElement) => {
    el.toggleAttribute('data-more-above', el.scrollTop > 1);
    el.toggleAttribute('data-more-below', el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  };
  useLayoutEffect(() => {
    const el = box.current;
    const content = inner.current;
    if (el === null || content === null) return;
    const fit = () => {
      const bar = el.offsetWidth - el.clientWidth;
      el.style.paddingInlineEnd = bar > 0 ? `max(0px, calc(var(--sop-card-pad-x) - ${bar}px))` : '';
      if (atEnd.current) el.scrollTop = el.scrollHeight;
      edges(el);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  // Only the owner leaves the end: the wheel or a swipe, the scroll bar, or a key that scrolls. A scroll event alone
  // cannot tell: it can come a frame late, after new words made the thread longer, or from a row getting shorter.
  // Reaching the end again, however it is reached, sticks again.
  const leave = () => {
    atEnd.current = false;
  };
  const onScroll = () => {
    const el = box.current;
    if (el === null) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX) atEnd.current = true;
    edges(el);
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => event.deltaY < 0 && leave();
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => event.target === event.currentTarget && leave();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => !(event.target instanceof HTMLTextAreaElement) && UP_KEYS.has(event.key) && leave();
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const el = box.current;
    if (el === null || !(event.target instanceof HTMLTextAreaElement)) return;
    const r = event.target.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    if (r.top < b.top) el.scrollTop -= b.top - r.top;
    else if (r.bottom > b.bottom) el.scrollTop += Math.min(r.bottom - b.bottom, r.top - b.top);
  };
  return (
    <div
      ref={box}
      className={styles.thread}
      onScroll={onScroll}
      onFocus={onFocus}
      onWheel={onWheel}
      onTouchMove={leave}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <div ref={inner}>{children}</div>
    </div>
  );
}

function editBox(props: ThreadCardProps, body: string) {
  return {
    value: body,
    autoFocus: true,
    onChange: (value: string) => props.onEditChange?.(value),
    onSend: (value: string) => props.onEditSave?.(value),
    onEscape: props.onEditEscape,
    onFlush: props.onDraftFlush,
    ...(props.onEditCancel ? { onCancel: () => props.onEditCancel?.() } : {}),
  };
}

/** Docs' comment menu: Edit (the owner's own comments only) and Delete. */
function commentActions(props: ThreadCardProps, comment: CommentView, isRoot: boolean): MenuItemDef[] {
  const items: MenuItemDef[] = [];
  if (props.onEditStart !== undefined && comment.author === 'me') {
    const edit = props.onEditStart;
    items.push({ kind: 'item', id: 'edit', label: 'Edit', onSelect: () => edit(comment.id) });
  }
  if (props.onDelete !== undefined) {
    const remove = props.onDelete;
    const replies = props.comments.length - 1;
    const text = isRoot ? (replies > 0 ? 'Delete note and replies' : 'Delete note') : 'Delete reply';
    items.push({ kind: 'item', id: 'delete', label: text, onSelect: () => remove(comment.id) });
  }
  return items;
}

/** What a note or reply that is still being written says, in place of its time. */
const NOT_SENT = 'Not sent yet';

/** The author row of the owner's new note. `time` null: no time line. */
function AuthorRow({ time }: { time?: string | null }) {
  return (
    <div className={styles.authorRow}>
      <CommentAvatar author="me" />
      <div className={styles.who}>
        <span className={styles.name}>{AUTHOR_NAME.me}</span>
        {time != null && <span className={styles.draftTime}>{time}</span>}
      </div>
    </div>
  );
}

/** Unsent text shown on an inactive card, so it is never out of sight. */
function DraftText({ text, lines = 4 }: { text: string; lines?: 2 | 4 }) {
  return (
    <p className={cx(styles.draftText, lines === 2 && styles.twoLines)}>{summarise(text) || 'Empty note'}</p>
  );
}

/**
 * "2 replies" on an inactive card, as Docs collapses a thread. A reply Claude is still writing is named, and so is a
 * thread whose last reply is Claude's that stopped with an error (TB6): after a reload the owner would otherwise see
 * only their own question, and not that it needs another try. Stopped by the owner is not "couldn't answer".
 */
function RepliesLine({ replies, onOpen }: { replies: CommentView[]; onOpen?: () => void }) {
  const last = replies.at(-1);
  const meta = last?.meta as Partial<ClaudeReplyMeta> | undefined;
  const claude = last?.author === 'claude';
  const writing = claude && (meta?.status === 'pending' || meta?.status === 'streaming');
  const failed = claude && meta?.status === 'error' && meta.error?.code !== 'cancelled';
  return (
    <p className={styles.replies}>
      <span className={styles.repliesCount}>{replies.length === 1 ? '1 reply' : `${replies.length} replies`}</span>
      {writing && <span className={styles.repliesNote}>Claude is replying…</span>}
      {failed && (
        <span className={styles.repliesFailed}>
          Claude couldn’t answer.
          {onOpen !== undefined && (
            <button
              type="button"
              className={styles.repliesOpen}
              // The card itself is in the Tab order and opens on Enter; this is the pointer's way in.
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                onOpen();
              }}
            >
              Open
            </button>
          )}
        </span>
      )}
    </p>
  );
}

function ContextLine({ label, quote }: { label: string | null; quote: string | null }) {
  if (label === null && (quote === null || quote === '')) return null;
  const parts = [label, quote ? quoted(quote) : null].filter(Boolean);
  return <p className={styles.context}>{parts.join(' · ')}</p>;
}

/** Quote marks that may already open or close a selected passage (curly, straight, low and angle quotes). */
const OPENING_QUOTE = /^["'“‘„«‹]/u;
const CLOSING_QUOTE = /["'”’»›]$/u;

/**
 * The passage in quote marks, on one line. A passage that already starts (or ends) with a quote mark keeps its own:
 * no doubled marks, as in ““parallel trends” (TB6).
 */
function quoted(text: string): string {
  const t = text.replace(/\s+/gu, ' ').trim();
  return `${OPENING_QUOTE.test(t) ? '' : '“'}${t}${CLOSING_QUOTE.test(t) ? '' : '”'}`;
}

function FigureRow({ figure }: { figure: CardFigure }) {
  return (
    <div className={styles.figure}>
      {figure.thumbnail !== null ? (
        <img className={styles.thumb} src={figure.thumbnail} alt={figure.label} draggable={false} />
      ) : (
        <span className={styles.thumb} aria-hidden="true" />
      )}
      <span className={styles.figureLabel}>{figure.label}</span>
    </div>
  );
}

function cardName(root: CommentView | undefined, replies: number, draft: string | null): string {
  if (root === undefined) return draft ? 'New note, not sent yet' : 'New note';
  const text = summarise(root.body);
  const short = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  const count = replies === 0 ? '' : replies === 1 ? ', 1 reply' : `, ${replies} replies`;
  return `Note by ${AUTHOR_NAME[root.author]}: ${short}${count}`;
}
