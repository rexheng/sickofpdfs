import '@sop/ui/tokens.css';
import '@sop/ui/base.css';
import { TextButton } from '@sop/ui';
import { homeUrl } from '../platform/app-events';
import styles from './PdfClosed.module.css';

/** A viewer page from the page history whose PDF was a file from another app: it was not kept, so it cannot open again. */
export function PdfClosed() {
  return (
    <div className={styles.card} role="status">
      <h1 className={styles.title}>This PDF is closed</h1>
      <p className={styles.text}>It came from another app and was not kept. Open it again from that app, or find it in your library.</p>
      <TextButton label="Go to library" variant="tonal" onClick={() => location.replace(homeUrl())} />
    </div>
  );
}
