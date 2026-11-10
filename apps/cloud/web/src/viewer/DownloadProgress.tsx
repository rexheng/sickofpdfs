// The bar under the header while the PDF comes from the cloud: how much has arrived, in plain words, and "Waiting for the
// connection…" while it is broken (the download goes on from where it stopped).
import { useSyncExternalStore } from 'react';
import { downloadProgress } from './open-cloud';
import styles from './DownloadProgress.module.css';

const mb = (n: number) => (n < 10 * 1024 * 1024 ? (n / (1024 * 1024)).toFixed(1) : String(Math.round(n / (1024 * 1024))));

/** True while the PDF is still coming down. */
export function useDownloading(): boolean {
  return useSyncExternalStore(downloadProgress.subscribe, downloadProgress.get, downloadProgress.get).kind === 'downloading';
}

/** `inline`: in the page's flow (the waiting screen before the viewer); otherwise floating under the viewer's header. */
export function DownloadProgress({ inline = false }: { inline?: boolean }) {
  const s = useSyncExternalStore(downloadProgress.subscribe, downloadProgress.get, downloadProgress.get);
  if (s.kind !== 'downloading') return null;
  const share = s.total === null || s.total === 0 ? null : Math.min(1, s.received / s.total);
  const words = s.waiting
    ? 'Waiting for the connection…'
    : s.total === null
      ? `Getting your PDF… ${mb(s.received)} MB`
      : `Getting your PDF… ${mb(s.received)} of ${mb(s.total)} MB`;
  return (
    <div className={inline ? styles.inline : styles.wrap} data-theme="light">
      <div
        role="progressbar"
        aria-label="Getting your PDF from your cloud"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(share !== null ? { 'aria-valuenow': Math.round(share * 100) } : {})}
        className={styles.track}
      >
        <div className={share === null ? styles.indeterminate : styles.bar} style={share === null ? undefined : { inlineSize: `${share * 100}%` }} />
      </div>
      <p className={styles.text} aria-live="polite">
        {words}
      </p>
    </div>
  );
}
