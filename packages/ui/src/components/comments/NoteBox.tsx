import {
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import '../../tokens/comments.css';
import { cx } from '../classes';
import styles from './NoteBox.module.css';

export interface NoteBoxProps {
  /** The text (Markdown). The box is controlled: the text lives with the caller, so closing the box never loses it. */
  value: string;
  /**
   * Every edit. The viewer passes it to `AnnotationSession.typeDraft`, which hands it to `DraftKeeper.change`; that
   * saves it within 300 ms of the last key (contracts section 3, "no lost text").
   */
  onChange: (value: string) => void;
  /** Enter, Ctrl+Enter or the send button, when the text is not blank. */
  onSend: (value: string) => void;
  /**
   * Esc. The box never clears itself: the caller decides what Esc means (a new note with text is sent, a reply stays a
   * draft) and closes the box. `onFlush` has already been called.
   */
  onEscape?: (value: string) => void;
  /** Save the draft now: called on blur, on Esc and when the box goes away. Wire it to `DraftKeeper.flush()`. */
  onFlush?: () => void;
  /**
   * The Cancel button, as Docs' comment box has: the caller throws the text away (a new note goes with its highlight, a
   * reply box empties, an edit keeps the sent text). Without it there is no Cancel button.
   */
  onCancel?: (value: string) => void;
  /** note: the first comment of a new note. reply: the reply box at the foot of an active card. edit: a sent comment. */
  variant?: 'note' | 'reply' | 'edit';
  placeholder?: string;
  /** The send button: "Comment", "Reply" or "Save". */
  sendLabel?: string;
  /** Take focus when shown, with the caret at the end of the text (a restored draft continues where it stopped). */
  autoFocus?: boolean;
  /** The accessible name of the text box. */
  label?: string;
  /** The <textarea>, for callers that move focus into the box. */
  inputRef?: Ref<HTMLTextAreaElement>;
  className?: string;
}

const DEFAULTS = {
  note: { placeholder: 'Add a note', sendLabel: 'Comment', label: 'Note', enter: 'Enter to send' },
  reply: { placeholder: 'Reply', sendLabel: 'Reply', label: 'Reply', enter: 'Enter to send' },
  edit: { placeholder: '', sendLabel: 'Save', label: 'Edit note', enter: 'Enter to save' },
} as const;

/**
 * The note box, as Google Docs' comment box (02 section 4.11), with the keys of the spec's "Writing a note" row:
 * Enter or Ctrl+Enter sends, Shift+Enter makes a new line, Esc closes without losing text, and Cancel (a text button
 * beside Send) throws the text away. A note is plain text for now (TB4 fix round): Ctrl+B and Ctrl+I do nothing in the
 * box, so no Markdown stars are typed, and they never bold the page either. Ctrl+Z and Ctrl+Y undo and redo inside the
 * box only. The box grows with the text up to about 8 lines, then scrolls.
 *
 * While the box has focus, no key reaches the viewer's shortcuts except Ctrl or Cmd with a key the box does not use
 * (Ctrl+F, Ctrl+P): single keys (H, 1–5, Delete) and Ctrl+Alt keys (AltGr on German and Polish keyboards) stay in
 * the box.
 */
export function NoteBox({
  value,
  onChange,
  onSend,
  onEscape,
  onFlush,
  onCancel,
  variant = 'note',
  placeholder,
  sendLabel,
  autoFocus = false,
  label,
  inputRef,
  className,
}: NoteBoxProps) {
  const defaults = DEFAULTS[variant];
  const field = useRef<HTMLTextAreaElement | null>(null);
  const setField = useCallback(
    (el: HTMLTextAreaElement | null) => {
      field.current = el;
      if (typeof inputRef === 'function') inputRef(el);
      else if (inputRef) inputRef.current = el;
    },
    [inputRef],
  );
  const hintId = useId();
  const [focused, setFocused] = useState(false);
  const blank = value.trim() === '';

  // The latest flush, for the clean-up below (a removed element does not always fire blur).
  const flush = useRef(onFlush);
  useEffect(() => {
    flush.current = onFlush;
  }, [onFlush]);
  useEffect(() => () => flush.current?.(), []);

  useLayoutEffect(() => {
    const el = field.current;
    if (!autoFocus || el === null) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
    // only when the box first appears: a later re-render must not move the caret
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(() => {
    if (field.current === null || field.current.value.trim() === '') return;
    onSend(field.current.value);
  }, [onSend]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent;
    const ctrl = event.ctrlKey || event.metaKey;
    // Typing stays in the box: only Ctrl or Cmd with a key the box does not use reaches the viewer.
    const letter = keyLetter(native);
    if (!ctrl || event.altKey || EDITING_LETTERS.has(letter)) event.stopPropagation();
    // An input method is composing (Japanese, Chinese, Korean): Enter commits the composition, it does not send.
    if (native.isComposing || native.keyCode === 229) return;

    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onFlush?.();
      onEscape?.(event.currentTarget.value);
      return;
    }
    if (!ctrl || event.altKey) return;
    if ((letter === 'b' || letter === 'i') && !event.shiftKey) {
      event.preventDefault(); // plain text for now: no Markdown stars, and the page's Ctrl+B never sees it
    } else if (letter === 'y' || (letter === 'z' && event.shiftKey)) {
      event.preventDefault();
      document.execCommand('redo');
    }
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    // Focus moving between the text and the send button is not leaving the box.
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setFocused(false);
    onFlush?.();
  };

  // The reply box is one quiet line until it is used; the note and edit boxes always show their button.
  const open = variant !== 'reply' || focused || !blank;

  return (
    <div
      className={cx(styles.box, className)}
      data-variant={variant}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      <textarea
        ref={setField}
        className={styles.field}
        value={value}
        rows={1}
        placeholder={placeholder ?? defaults.placeholder}
        aria-label={label ?? defaults.label}
        aria-describedby={hintId}
        aria-keyshortcuts="Enter Shift+Enter Escape"
        spellCheck
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.actions} hidden={!open}>
        {/* A quiet hint while typing, on its own line over the buttons: "Enter to send · Shift+Enter for a new line". */}
        <span id={hintId} className={styles.hint}>
          <span className={styles.hintLine}>
            {defaults.enter}
            <span aria-hidden="true"> ·</span>
            <span className={styles.srOnly}>.</span>
          </span>
          <span className={styles.hintLine}>Shift+Enter for a new line</span>
        </span>
        {onCancel !== undefined && (
          <button
            type="button"
            className={styles.cancel}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onFlush?.();
              onCancel(field.current?.value ?? value);
            }}
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          className={styles.send}
          disabled={blank}
          // keep the focus (and the caret) in the text box while the button is pressed
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            send();
          }}
        >
          {sendLabel ?? defaults.sendLabel}
        </button>
      </div>
    </div>
  );
}

export type ReplyBoxProps = Omit<NoteBoxProps, 'variant'>;

/**
 * The reply box at the foot of an active card: one quiet line ("Reply", 38 px, radius 16, as in Docs) that opens to
 * show its button when it has focus or text. A reply that is not sent yet stays in it as a draft.
 */
export function ReplyBox(props: ReplyBoxProps) {
  return <NoteBox {...props} variant="reply" />;
}

/** Letters the box handles itself, so they never reach the viewer: formatting, undo and redo, and clipboard keys. */
const EDITING_LETTERS = new Set(['a', 'b', 'c', 'i', 'u', 'v', 'x', 'y', 'z']);

/**
 * The letter a key types, lower case. Shortcuts follow the keyboard layout (spec "Shortcuts"); on a layout without
 * Latin letters (Cyrillic, Greek) the key's position stands in, so Ctrl+B still means bold.
 */
function keyLetter(event: globalThis.KeyboardEvent): string {
  if (/^[a-z]$/iu.test(event.key)) return event.key.toLowerCase();
  if (/^\p{L}$/u.test(event.key) && /^Key[A-Z]$/u.test(event.code)) return event.code.slice(3).toLowerCase();
  return '';
}
