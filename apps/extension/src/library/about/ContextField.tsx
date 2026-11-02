// "Your context" (R92): a short note on why the owner is reading this PDF. It is the reading's document note, so it also
// shows in the viewer's notes and on the Notes page. The words are saved as they are typed (a moment after the last key)
// and when the box loses the focus.
import { type ChangeEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import styles from './ContextField.module.css';
import { MAX_CONTEXT } from './about-data';

export type ContextStatus = 'idle' | 'saving' | 'saved' | 'failed';

export interface ContextFieldProps {
  /** The stored words; null while they load. A change from elsewhere shows unless the owner is typing here. */
  stored: string | null;
  /** Saves the words (an empty box removes the note). */
  save(this: void, text: string): Promise<void>;
  /** Each keystroke, for a keeper that holds unsent words safe (the viewer's draft keeper). */
  typed?(this: void, text: string): void;
  disabled?: boolean;
  /** Why it is off ("Save this PDF to your library to add your context."). */
  disabledText?: string;
}

/** How long after the last key the words are saved. */
const SAVE_AFTER_MS = 700;

export function ContextField({ stored, save, typed, disabled = false, disabledText }: ContextFieldProps) {
  const [text, setText] = useState(stored ?? '');
  const [status, setStatus] = useState<ContextStatus>('idle');
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const hint = useId();
  const latest = useRef({ text, save });
  latest.current = { text, save };

  // The box grows with its words, so the whole context is always in view.
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    el.style.blockSize = 'auto';
    el.style.blockSize = `${el.scrollHeight + 2}px`;
  }, [text]);

  // Words saved elsewhere (the viewer, another tab) show here unless this box has words of its own not yet saved.
  useEffect(() => {
    if (stored !== null && !dirty.current && document.activeElement !== box.current) setText(stored);
  }, [stored]);

  const flush = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    const words = latest.current.text;
    setStatus('saving');
    latest.current.save(words).then(
      () => setStatus((s) => (s === 'saving' ? 'saved' : s)),
      () => {
        dirty.current = true; // kept, and tried again with the next key or when the box is left
        setStatus('failed');
      },
    );
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // The box going away (the panel closed, another reading picked) saves what was typed.
  useEffect(() => () => flushRef.current(), []);
  useEffect(() => {
    const onHide = () => flushRef.current();
    addEventListener('pagehide', onHide);
    return () => removeEventListener('pagehide', onHide);
  }, []);

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.currentTarget.value.slice(0, MAX_CONTEXT);
    setText(next);
    dirty.current = true;
    setStatus('idle');
    typed?.(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => flushRef.current(), SAVE_AFTER_MS);
  };

  const line =
    disabled && disabledText !== undefined
      ? disabledText
      : status === 'saving'
        ? 'Saving…'
        : status === 'saved'
          ? 'Saved'
          : status === 'failed'
            ? 'Couldn’t save. Your words are still here; keep typing or click away to try again.'
            : 'Saved as you type. It also shows as a note on the whole PDF.';

  return (
    <div className={styles.field}>
      <textarea
        ref={box}
        className={styles.box}
        value={text}
        rows={3}
        maxLength={MAX_CONTEXT}
        disabled={disabled || stored === null}
        aria-label="Your context"
        aria-describedby={hint}
        placeholder="Why are you reading this? For a course, a project, a question you have…"
        onChange={onChange}
        onBlur={() => flushRef.current()}
      />
      <p id={hint} className={styles.status} data-status={status} aria-live="polite">
        {line}
      </p>
    </div>
  );
}
