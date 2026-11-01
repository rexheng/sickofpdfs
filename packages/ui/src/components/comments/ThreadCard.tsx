import type { ClaudeReplyMeta, CommentId } from '@sop/core';
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react';
import '../../tokens/comments.css';
import { cx } from '../classes';
import type { MenuItemDef } from '../Menu';
import { AUTHOR_NAME, CommentAvatar } from './CommentAvatar';
import { CommentItem } from './CommentItem';
import { summarise } from './markdown';
import { MovedLabel, UnplacedLabel } from './MovedLabel';
import { NoteBox, ReplyBox } from './NoteBox';
import styles from './ThreadCard.module.css';
import type { CardFigure, CardPlacement, ChipLink, CommentView } from './types';

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

  /** The comment being edited in place, and its text. */
  editing?: { id: CommentId; body: string } | null;
  /** "Edit" in a comment's ⋮ menu. Only the owner's own comments offer it: Claude's are never rewritten. */
  onEditStart?: (id: CommentId) => void;
  onEditChange?: (body: string) => void;
  onEditSave?: (body: string) => void;
  onEditEscape?: (body: string) => void;
  /** "Delete" in a comment's ⋮ menu. On the first comment it deletes the whole note. */
  onDelete?: (id: CommentId) => void;
  /** "Try again" on a Claude reply that stopped with an error. */
  onRetry?: (id: CommentId) => void;
  /** A citation chip in a reply was pressed. */
  onChip?: (link: ChipLink, comment: CommentId) => void;
  renderChip?: (link: ChipLink) => ReactNode;

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

/** A new note: the owner's name and the note box (active), or the unsent text marked "Draft" (inactive). */
function NewNote({ draft, active, autoFocus, onDraftChange, onDraftSend, onDraftEscape, onDraftFlush }: ThreadCardProps) {
  if (!active) {
    return (
      <>
        <AuthorRow time="Draft" />
        <DraftText text={draft ?? ''} />
      </>
    );
  }
  return (
    <>
      <AuthorRow />
      <NoteBox
        className={styles.noteBox}
        variant="note"
        value={draft ?? ''}
        autoFocus={autoFocus}
        onChange={(body) => onDraftChange?.(body)}
        onSend={(body) => onDraftSend?.(body)}
        onEscape={onDraftEscape}
        onFlush={onDraftFlush}
      />
    </>
  );
}

function Thread(props: ThreadCardProps & { root: CommentView; replies: CommentView[] }) {
  const { root, replies, active, draft = null, editing, now, autoFocus, onActivate, onRetry, onChip, renderChip } = props;
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
    />
  );

  if (!active) {
    return (
      <>
        {item(root, true)}
        {replies.length > 0 && <RepliesLine replies={replies} />}
        {draft !== null && draft !== '' && (
          <div className={styles.replyDraft}>
            <span className={styles.draftLabel}>Draft reply</span>
            <DraftText text={draft} lines={2} />
          </div>
        )}
      </>
    );
  }
  return (
    <>
      {item(root, true)}
      {replies.map((reply) => item(reply, false))}
      {editing == null && (
        <ReplyBox
          className={styles.replyBox}
          value={draft ?? ''}
          autoFocus={autoFocus}
          onChange={(body) => props.onDraftChange?.(body)}
          onSend={(body) => props.onDraftSend?.(body)}
          onEscape={props.onDraftEscape}
          onFlush={props.onDraftFlush}
        />
      )}
    </>
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

/** The author row of the owner's new note. `time` null: no time line (the active note box). */
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

/** "2 replies" on an inactive card, as Docs collapses a thread. A reply Claude is still writing is named. */
function RepliesLine({ replies }: { replies: CommentView[] }) {
  const last = replies.at(-1);
  const meta = last?.meta as Partial<ClaudeReplyMeta> | undefined;
  const writing = last?.author === 'claude' && (meta?.status === 'pending' || meta?.status === 'streaming');
  return (
    <p className={styles.replies}>
      <span className={styles.repliesCount}>{replies.length === 1 ? '1 reply' : `${replies.length} replies`}</span>
      {writing && <span className={styles.repliesNote}>Claude is replying…</span>}
    </p>
  );
}

function ContextLine({ label, quote }: { label: string | null; quote: string | null }) {
  if (label === null && (quote === null || quote === '')) return null;
  const parts = [label, quote ? `“${quote.replace(/\s+/gu, ' ').trim()}”` : null].filter(Boolean);
  return <p className={styles.context}>{parts.join(' · ')}</p>;
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
