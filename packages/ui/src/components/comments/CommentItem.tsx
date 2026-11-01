import type { ClaudeReplyMeta, CommentMeta, ConflictCopyMeta } from '@sop/core';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import '../../tokens/comments.css';
import { cx } from '../classes';
import { IconButton } from '../IconButton';
import { DropdownMenu, type MenuItemDef } from '../Menu';
import { TextButton } from '../TextButton';
import { AUTHOR_NAME, CommentAvatar } from './CommentAvatar';
import styles from './CommentItem.module.css';
import { MarkdownBody } from './MarkdownBody';
import { NoteBox, type NoteBoxProps } from './NoteBox';
import { formatCommentTime, formatCommentTimeFull } from './time';
import type { ChipLink, CommentView } from './types';

export interface CommentItemProps {
  comment: CommentView;
  /** "Now" for the time labels ("Today"). Defaults to the time of drawing. */
  now?: number;
  /** Clamp a long body to 4 lines with "Show more" (inactive cards). */
  clamp?: boolean;
  /** "Show more" was pressed. The card makes itself active, and an active card shows every line. */
  onShowMore?: () => void;
  /** The comment's ⋮ menu. No items, no button. */
  actions?: MenuItemDef[];
  /** Show the ⋮ button only while the pointer or keyboard focus is on the comment (replies, as in Docs). */
  actionsOnHover?: boolean;
  /** Edit in place: a note box takes the body's place. */
  edit?: Omit<NoteBoxProps, 'variant'> | null;
  /** "Try again" on a Claude reply that stopped with an error (P4 reuses the same comment id). */
  onRetry?: () => void;
  onChip?: (link: ChipLink) => void;
  renderChip?: (link: ChipLink) => ReactNode;
  className?: string;
}

/**
 * One comment of a thread, laid out as a Docs comment (02 section 4.11): a 32 px avatar, the author's name (14/20 500)
 * and the time (12/16) beside it, then the Markdown body (14/20) 12 px below. A reply from Claude shows Claude's name
 * and mark, and its `meta.status`: reading (pending), writing with a caret (streaming), done, or stopped with an error
 * and "Try again". The full Claude flow arrives in Phase 4; these states are its placeholders.
 */
export function CommentItem({
  comment,
  now,
  clamp = false,
  onShowMore,
  actions,
  actionsOnHover = false,
  edit,
  onRetry,
  onChip,
  renderChip,
  className,
}: CommentItemProps) {
  const claude = claudeMeta(comment.meta);
  const status = claude?.status ?? 'done';
  const hasActions = actions !== undefined && actions.length > 0;

  return (
    <div className={cx(styles.comment, actionsOnHover && styles.hoverActions, className)}>
      <div className={styles.head}>
        <CommentAvatar author={comment.author} />
        <div className={styles.who}>
          <span className={styles.name}>{AUTHOR_NAME[comment.author]}</span>
          <CommentTime comment={comment} now={now} />
        </div>
        {hasActions && (
          <DropdownMenu
            align="end"
            items={actions}
            trigger={<IconButton icon="more_vert" label="More options" className={styles.menu} />}
          />
        )}
      </div>
      <div className={styles.content}>
        {edit ? (
          <NoteBox {...edit} variant="edit" />
        ) : status === 'pending' || (status === 'streaming' && comment.body === '') ? (
          <p className={styles.status} role="status">
            Claude is reading
            <span className={styles.dots} aria-hidden="true">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </p>
        ) : (
          <>
            {comment.body !== '' && (
              <ClampedBody clamp={clamp} text={comment.body} onShowMore={onShowMore}>
                <MarkdownBody
                  source={comment.body}
                  onChip={onChip}
                  renderChip={renderChip}
                  tail={status === 'streaming' ? <span className={styles.caret} aria-hidden="true" /> : undefined}
                />
              </ClampedBody>
            )}
            {status === 'error' && (
              <div className={styles.error} role="alert">
                <p className={styles.errorText}>{claude?.error?.message ?? 'Claude stopped before it finished.'}</p>
                {onRetry !== undefined && <TextButton label="Try again" className={styles.retry} onClick={onRetry} />}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The time line under the name: "9:24 PM Today", plus "Edited", "Draft" or where the comment came from. */
function CommentTime({ comment, now }: { comment: CommentView; now?: number }) {
  const at = now ?? Date.now();
  const parts: string[] = [];
  if (comment.draftOfTab !== null && comment.author === 'me') parts.push('Draft');
  else parts.push(formatCommentTime(comment.createdAt, at));
  if (comment.editedAt !== null) parts.push('Edited');
  const meta = comment.meta as Partial<ClaudeReplyMeta> | Partial<ConflictCopyMeta>;
  if (meta.kind === 'conflict-copy') parts.push('Edited on another device');
  if (meta.kind === 'claude-reply' && meta.via === 'connector') parts.push('from claude.ai');
  return (
    <time
      className={cx(styles.time, comment.draftOfTab !== null && styles.draft)}
      dateTime={new Date(comment.createdAt).toISOString()}
      title={formatCommentTimeFull(comment.createdAt)}
    >
      {parts.join(' · ')}
    </time>
  );
}

/** A body that stops at 4 lines with "Show more" when `clamp` is on and the text is longer. */
function ClampedBody({
  clamp,
  text,
  onShowMore,
  children,
}: {
  clamp: boolean;
  /** The body text: measured again when it changes (a streaming reply grows inside a fixed 4-line box). */
  text: string;
  onShowMore?: () => void;
  children: ReactNode;
}) {
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
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [clamp, text]);

  return (
    <>
      <div ref={box} className={cx(clamp && styles.clamped)}>
        {children}
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
    </>
  );
}

function claudeMeta(meta: CommentMeta): ClaudeReplyMeta | null {
  return (meta as Partial<ClaudeReplyMeta>).kind === 'claude-reply' ? (meta as ClaudeReplyMeta) : null;
}
