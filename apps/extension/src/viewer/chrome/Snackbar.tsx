import { useEffect, useRef, useState } from 'react';
import type { NoteAction } from '../commands';
import styles from './Snackbar.module.css';

/** A note: its words, and at most one button ("Forget"). */
export interface SnackbarNote {
  text: string;
  action?: NoteAction;
}

export interface SnackbarProps {
  /** The message; a new object shows again even with the same words. Null shows nothing. */
  note: SnackbarNote | null;
}

/** How long a note stays. */
const SHOW_MS = 4000;
/** A note with a button stays longer, so there is time to reach it (GM3: up to 10 s), and while the pointer or focus is on it. */
const ACTION_MS = 10_000;
const READ_MS_PER_CHAR = 60;

/**
 * A short note after an action that shows no result of its own ("Link copied"), as Drive confirms one: GM3's snackbar
 * at the bottom left, on the inverse surface, with an optional text button in the inverse primary. It is a status region,
 * so screen readers read it, and it goes by itself.
 */
export function Snackbar({ note }: SnackbarProps) {
  const [shown, setShown] = useState<SnackbarNote | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (note === null) return;
    setShown(note);
    // A longer note stays longer, so it can be read to the end (about 60 ms a character).
    const ms = Math.max(note.action === undefined ? SHOW_MS : ACTION_MS, note.text.length * READ_MS_PER_CHAR);
    let timer: ReturnType<typeof setTimeout>;
    const later = (): void => {
      timer = setTimeout(() => {
        if (note.action !== undefined && bar.current?.matches(':hover, :focus-within') === true) later();
        else setShown(null);
      }, ms);
    };
    later();
    return () => clearTimeout(timer);
  }, [note]);
  return (
    <div role="status" className={styles.region}>
      {shown !== null && (
        <div ref={bar} key={shown.text} className={shown.action === undefined ? styles.snackbar : `${styles.snackbar} ${styles.withAction}`}>
          <span className={styles.text}>{shown.text}</span>
          {shown.action !== undefined && (
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                shown.action?.run();
                setShown(null);
              }}
            >
              {shown.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
