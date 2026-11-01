import '../tokens/tokens.css';
import { useEffect, useRef } from 'react';
import { IconButton } from '../components/IconButton';
import styles from './Snackbar.module.css';

export interface SnackbarMessage {
  /** A new id for each message, so the same words shown twice still restart the timer. */
  id: number;
  text: string;
  action?: { label: string; onClick: () => void };
}

export interface SnackbarProps {
  message: SnackbarMessage | null;
  onDismiss(this: void): void;
}

/** How long a message stays, unless the pointer or the focus is on it. */
const SHOW_MS = 8000;

/**
 * Drive's snackbar (GM3): a dark bar at the bottom left with the message, an optional action ("Undo") in the inverse
 * primary, and a close button. It is a polite live region, so a screen reader reads each message once.
 */
export function Snackbar({ message, onDismiss }: SnackbarProps) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message === null) return;
    const timer = setInterval(() => {
      if (bar.current?.matches(':hover, :focus-within') === true) return;
      clearInterval(timer);
      onDismiss();
    }, SHOW_MS);
    return () => clearInterval(timer);
  }, [message, onDismiss]);
  return (
    <div className={styles.region} role="status" aria-live="polite">
      {message !== null && (
        <div ref={bar} key={message.id} className={styles.bar}>
          <span className={styles.text}>{message.text}</span>
          {message.action !== undefined && (
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                message.action?.onClick();
                onDismiss();
              }}
            >
              {message.action.label}
            </button>
          )}
          <IconButton className={styles.close} icon="close" label="Close" size={40} iconSize={20} onClick={onDismiss} />
        </div>
      )}
    </div>
  );
}
