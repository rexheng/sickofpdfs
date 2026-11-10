// Drive's upload panel, at the bottom right (on a phone, across the bottom): "Uploading 2 items", one row per PDF with its
// progress ring or result, and under each name what is happening, in plain words. "Not sure" asks in a dialog.
import { Dialog, FileTypeIcon, Icon, IconButton } from '@sop/ui';
import { useState, useSyncExternalStore } from 'react';
import { type UploadItem, finished, uploads } from './uploads';
import styles from './UploadPanel.module.css';

const mb = (n: number) => (n < 10 * 1024 * 1024 ? (n / (1024 * 1024)).toFixed(1) : String(Math.round(n / (1024 * 1024))));

/** What a row says under its name. */
function line(i: UploadItem): string {
  const s = i.step;
  switch (s.kind) {
    case 'queued':
      return 'Waiting…';
    case 'reading':
      return 'Reading the file…';
    case 'checking':
      return 'Checking it’s a reading…';
    case 'asking':
      return 'Is it a reading? Answer above.';
    case 'uploading':
      return `${mb(s.sent)} of ${mb(s.total)} MB`;
    case 'waiting':
      return `No connection. It goes on when you’re back online (${mb(s.sent)} of ${mb(s.total)} MB).`;
    case 'text':
      return 'Making its words searchable…';
    case 'done':
      return s.note ?? 'Added to your library';
    case 'refused':
    case 'failed':
      return s.why;
  }
}

function Ring({ share }: { share: number | null }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg className={share === null ? styles.spin : undefined} width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r={r} className={styles.ringTrack} />
      <circle cx="12" cy="12" r={r} className={styles.ringBar} strokeDasharray={c} strokeDashoffset={share === null ? c * 0.7 : c * (1 - share)} transform="rotate(-90 12 12)" />
    </svg>
  );
}

function Status({ item }: { item: UploadItem }) {
  const s = item.step;
  if (s.kind === 'done') return <Icon name="check_circle" size={24} filled className={styles.ok} />;
  if (s.kind === 'refused') return <Icon name="block" size={24} className={styles.no} />;
  if (s.kind === 'failed') return <Icon name="error" size={24} filled className={styles.no} />;
  if (s.kind === 'uploading' || s.kind === 'waiting') return <Ring share={s.total > 0 ? s.sent / s.total : null} />;
  return <Ring share={null} />;
}

export function UploadPanel() {
  const items = useSyncExternalStore(uploads.subscribe, uploads.items, uploads.items);
  const question = useSyncExternalStore(uploads.subscribe, uploads.question, uploads.question);
  const [open, setOpen] = useState(true);
  if (items.length === 0 && question === null) return null;
  const left = items.filter((i) => !finished(i)).length;
  const added = items.filter((i) => i.step.kind === 'done').length;
  const title =
    left > 0 ? (left === 1 ? 'Uploading 1 item' : `Uploading ${left} items`) : added === items.length ? (added === 1 ? '1 upload complete' : `${added} uploads complete`) : `${added} of ${items.length} added`;
  return (
    <>
      {items.length > 0 && (
        <section className={styles.panel} aria-label="Uploads" data-theme="light">
          <header className={styles.head}>
            <h2 className={styles.title} aria-live="polite">
              {title}
            </h2>
            <IconButton icon={open ? 'expand_more' : 'expand_less'} label={open ? 'Hide uploads' : 'Show uploads'} size={40} onClick={() => setOpen(!open)} />
            <IconButton
              icon="close"
              label={left > 0 ? 'Close (uploads keep going)' : 'Close'}
              size={40}
              disabled={left > 0}
              disabledReason="uploads are still going"
              onClick={() => uploads.clearFinished()}
            />
          </header>
          {open && (
            <ul className={styles.list}>
              {items.map((i) => (
                <li key={i.id} className={styles.row} data-upload={i.step.kind}>
                  <FileTypeIcon kind="pdf" size={24} />
                  <div className={styles.text}>
                    <span className={styles.name} title={i.name}>
                      {i.name}
                    </span>
                    <span className={styles.line} data-warn={i.step.kind === 'refused' || i.step.kind === 'failed' ? '' : undefined}>
                      {line(i)}
                    </span>
                  </div>
                  <span className={styles.status}>
                    <Status item={i} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <Dialog
        open={question !== null}
        title="Is this a reading?"
        onOpenChange={(o) => {
          if (!o) question?.answer(false);
        }}
        actions={[
          { label: 'Leave it out', onClick: () => question?.answer(false) },
          { label: 'Add it', primary: true, onClick: () => question?.answer(true) },
        ]}
      >
        <p className={styles.ask}>We couldn’t tell if “{question?.name}” is for learning.</p>
        <p className={styles.ask}>Only readings go to your cloud. Receipts, bills and private papers stay off it.</p>
      </Dialog>
    </>
  );
}
