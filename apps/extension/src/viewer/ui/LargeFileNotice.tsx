import { Icon, TextButton } from '@sop/ui';
import styles from './cards.module.css';
import { tooLargeText } from './LoadErrorCard';

export interface LargeFileNoticeProps {
  /** The file's size in bytes, from the download header. */
  size: number;
  onOpenNow: () => void;
}

/** The note shown for two seconds before a PDF over 1 GB (or too big for the engine's memory) moves to Chrome's viewer. */
export function LargeFileNotice({ size, onOpenNow }: LargeFileNoticeProps) {
  return (
    <div className={styles.stage}>
      <section className={styles.card} role="status">
        <Icon name="info" className={styles.icon} />
        <p className={styles.body}>
          {`${tooLargeText(size)} Opening it in Chrome’s viewer…`}
        </p>
        <div className={styles.actions}>
          <TextButton label="Open now" onClick={onOpenNow} />
        </div>
      </section>
    </div>
  );
}
