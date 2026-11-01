import { useEffect, useState } from 'react';
import styles from './Snackbar.module.css';

export interface SnackbarProps {
  /** The message; a new object shows again even with the same words. Null shows nothing. */
  note: { text: string } | null;
}

/** How long a note stays. */
const SHOW_MS = 4000;
const READ_MS_PER_CHAR = 60;

/**
 * A short note after an action that shows no result of its own ("Link copied"), as Drive confirms one: GM3's snackbar
 * at the bottom left, on the inverse surface. It is a status region, so screen readers read it, and it goes by itself.
 */
export function Snackbar({ note }: SnackbarProps) {
  const [shown, setShown] = useState<{ text: string } | null>(null);
  useEffect(() => {
    if (note === null) return;
    setShown(note);
    // A longer note stays longer, so it can be read to the end (about 60 ms a character).
    const timer = setTimeout(() => setShown(null), Math.max(SHOW_MS, note.text.length * READ_MS_PER_CHAR));
    return () => clearTimeout(timer);
  }, [note]);
  return (
    <div role="status" className={styles.region}>
      {shown !== null && (
        <div key={shown.text} className={styles.snackbar}>
          {shown.text}
        </div>
      )}
    </div>
  );
}
