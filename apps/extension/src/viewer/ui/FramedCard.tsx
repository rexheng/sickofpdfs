import { FileTypeIcon, TextButton } from '@sop/ui';
import styles from './cards.module.css';

export interface FramedCardProps {
  /** What to call the PDF (displayNameFor). */
  name: string;
  /** Opens the PDF in a new tab; null when the viewer may not offer that (a local file under a web page). */
  onOpenInNewTab: (() => void) | null;
}

/**
 * What a viewer in a frame shows when the PDF does not move to the whole tab. It never shows the PDF itself there
 * (frame-escape.ts): one button opens it in a new tab. Frames are often small, so the card is compact.
 */
export function FramedCard({ name, onOpenInNewTab }: FramedCardProps) {
  return (
    <div className={`${styles.stage} ${styles.compactStage}`}>
      <section className={`${styles.card} ${styles.compactCard}`} aria-labelledby="framed-title">
        <FileTypeIcon kind="pdf" size={32} />
        <h1 id="framed-title" className={`${styles.title} ${styles.oneLine}`}>
          {name}
        </h1>
        {onOpenInNewTab === null ? (
          <>
            <p className={styles.body}>A web page asked to show a file from your computer here.</p>
            <p className={styles.body}>It is not shown.</p>
          </>
        ) : (
          <>
            <p className={styles.body}>This PDF opens in its own tab.</p>
            <div className={styles.actions}>
              <TextButton label="Open in a new tab" icon="open_in_new" onClick={onOpenInNewTab} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
