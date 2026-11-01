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
  note: { placeholder: 'Add a note', sendLabel: 'Comment', label: 'Note' },
  reply: { placeholder: 'Reply', sendLabel: 'Reply', label: 'Reply' },
  edit: { placeholder: '', sendLabel: 'Save', label: 'Edit note' },
} as const;

/**
 * The note box, as Google Docs' comment box (02 section 4.11), with the keys of the spec's "Writing a note" row:
 * Enter or Ctrl+Enter sends, Shift+Enter makes a new line, Esc closes without losing text. Ctrl+B and Ctrl+I wrap the
 * selection in Markdown bold and italic, and Ctrl+Z and Ctrl+Y undo and redo inside the box only. The box grows with
 * the text up to about 8 lines, then scrolls.
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
    const el = event.currentTarget;
    if (letter === 'b' && !event.shiftKey) {
      event.preventDefault();
      toggleWrap(el, '**');
    } else if (letter === 'i' && !event.shiftKey) {
      event.preventDefault();
      toggleWrap(el, '*');
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
        aria-keyshortcuts="Enter Shift+Enter Escape Control+B Control+I"
        spellCheck
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.actions} hidden={!open}>
        <span id={hintId} className={styles.hint}>
          <span className={styles.srOnly}>Enter to send. </span>
          Shift+Enter for a new line
        </span>
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

/**
 * Wraps the selection in a Markdown mark (`**` bold, `*` italic), or unwraps it when it is already wrapped. It edits
 * through execCommand('insertText'), so the change joins the box's own undo history and fires a normal input event.
 */
function toggleWrap(el: HTMLTextAreaElement, mark: string) {
  const { selectionStart: start, selectionEnd: end, value } = el;
  const selected = value.slice(start, end);
  const before = value.slice(start - mark.length, start);
  const after = value.slice(end, end + mark.length);
  // For italic, a star that is half of a bold pair (**) is not an italic mark.
  const lone = (at: number) => mark !== '*' || value[at] !== '*';
  const boldInside = mark === '*' && selected.startsWith('**') && !selected.startsWith('***');
  if (before === mark && after === mark && lone(start - mark.length - 1) && lone(end + mark.length)) {
    el.setSelectionRange(start - mark.length, end + mark.length);
    insertText(el, selected);
    el.setSelectionRange(start - mark.length, end - mark.length);
  } else if (!boldInside && selected.length > mark.length * 2 && selected.startsWith(mark) && selected.endsWith(mark)) {
    insertText(el, selected.slice(mark.length, -mark.length));
    el.setSelectionRange(start, end - mark.length * 2);
  } else {
    insertText(el, `${mark}${selected}${mark}`);
    el.setSelectionRange(start + mark.length, end + mark.length);
  }
}

function insertText(el: HTMLTextAreaElement, text: string) {
  el.focus();
  // execCommand keeps the native undo stack; the fallback (no undo) is for browsers without it.
  if (!document.execCommand('insertText', false, text)) {
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
