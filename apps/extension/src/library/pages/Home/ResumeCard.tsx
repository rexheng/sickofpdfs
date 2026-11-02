// A reading on Home's "Continue reading": a Drive grid card (02 section 4.7) with the first page, and under it where the owner
// stopped ("Page 6 of 15", with a thin bar), how long they have read it, and when they last opened it. A click or Enter opens it.
import { FileTypeIcon } from '@sop/ui';
import { CardThumbnail } from '../../components/CardThumbnail';
import { formatDate, formatDateLong, formatPages, formatReadingTime, readingTitle } from '../../components/format';
import styles from './Home.module.css';
import type { ContinueItem } from './use-continue';

export function ResumeCard({ entry, now, onOpen }: { entry: ContinueItem; now: number; onOpen(this: void): void }) {
  const { item, reading } = entry;
  const title = readingTitle(item);
  const pages = item.doc.pageCount;
  const page = reading?.lastPosition?.page ?? null;
  const share = page === null || pages <= 0 ? null : Math.min(1, (page + 1) / pages);
  const time = reading !== null && reading.readingMs > 0 ? reading.readingMs : item.readingMs;
  return (
    <button type="button" className={styles.card} onClick={onOpen} title={`Open ${title}`}>
      <span className={styles.cardHead}>
        <FileTypeIcon kind="pdf" size={24} />
        <span className={styles.cardName}>{title}</span>
      </span>
      <span className={styles.cardThumb}>
        <CardThumbnail id={item.doc.id} stored={item.doc.blobStored} />
      </span>
      <span className={styles.cardFoot}>
        <span className={styles.cardWhere}>{page === null ? formatPages(pages) : `Page ${page + 1} of ${pages}`}</span>
        {share !== null && (
          <span className={styles.bar} role="presentation">
            <span className={styles.barFill} style={{ inlineSize: `${Math.round(share * 100)}%` }} />
          </span>
        )}
        {time >= 60_000 && <span className={styles.cardWhen}>Read for {formatReadingTime(time)}</span>}
        <span className={styles.cardWhen} title={formatDateLong(item.lastOpened)}>
          You opened it · {formatDate(item.lastOpened, now)}
        </span>
      </span>
    </button>
  );
}
