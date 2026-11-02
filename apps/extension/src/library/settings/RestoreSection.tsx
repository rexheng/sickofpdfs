// Settings → Restore (plan S17; spec: '"Restore from backup" in Settings rebuilds the library on a fresh install, merging by fingerprint
// and id'). One click picks the backup folder; a dialog says what it holds; Restore merges it in, copies the PDFs and then has their text
// read again in the background ("Indexing 3 of 12"). The last restore's result stays here in plain words, with R88's count of readings
// removed here that were left out.
//
// This file never reaches the secrets store (eslint.config.mjs bars it, as it does the Backup section).
import { TextButton } from '@sop/ui';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { indexingWords, onReindexProgress, type ReindexProgress } from '../../backup/reindex-protocol';
import { outcomeLines, type RestoreProgress } from '../../backup/restore';
import { keepLastRestore, onLastRestore, openRestore, pickBackupFolder, type RestoreRecord, type RestoreSession } from '../../backup/restore-client';
import { LibraryContext } from '../app/context';
import { SettingsRow, SettingsSection } from '../pages/Settings/SettingsSection';
import { RestoreDialog, type RestoreDialogState } from './RestoreDialog';
import styles from './RestoreSection.module.css';

function useNotify(): (text: string) => void {
  const library = useContext(LibraryContext);
  return useCallback((text: string) => library?.notify({ text }), [library]);
}

function useLastRestore(): [RestoreRecord | null, (r: RestoreRecord) => void] {
  const [last, setLast] = useState<RestoreRecord | null>(null);
  useEffect(() => onLastRestore(setLast), []);
  return [last, setLast];
}

/**
 * The indexer's progress, once this page has seen a round run (a round that ended before the page opened, or before the last restore
 * started, is not news). `forget` starts afresh: a new restore shows its own round, or none when it has nothing to read.
 */
function useIndexing(): [ReindexProgress | null, () => void] {
  const [progress, setProgress] = useState<ReindexProgress | null>(null);
  const seen = useRef(false);
  useEffect(
    () =>
      onReindexProgress((p) => {
        if (p.active) seen.current = true;
        if (seen.current && p.total > 0) setProgress(p);
      }),
    [],
  );
  const forget = useCallback(() => {
    seen.current = false;
    setProgress(null);
  }, []);
  return [progress, forget];
}

const restoredOn = (t: number): string => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(t);

function Bar({ label, done, total }: { label: string; done: number | null; total: number }) {
  if (done === null) {
    return (
      <div className={styles.track} role="progressbar" aria-label={label}>
        <div className={`${styles.fill} ${styles.moving}`} />
      </div>
    );
  }
  return (
    <div className={styles.track} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <div className={styles.fill} style={{ inlineSize: `${total === 0 ? 0 : (done / total) * 100}%` }} />
    </div>
  );
}

/** How long after a restore its section keeps scrolling into view while the indexing has not started. */
const FOLLOW_AFTER_MS = 5000;

const runningWords = (p: RestoreProgress): string =>
  p.step === 'merging' ? 'Adding your readings and notes…' : `Copying PDFs: ${Math.min(p.done + 1, p.total)} of ${p.total}`;

export function RestoreSection() {
  const notify = useNotify();
  const [dialog, setDialog] = useState<RestoreDialogState | null>(null);
  const [running, setRunning] = useState<RestoreProgress | null>(null);
  const [stopped, setStopped] = useState<string | null>(null);
  const [last, setLast] = useLastRestore();
  const [indexing, forgetIndexing] = useIndexing();
  const session = useRef<RestoreSession | null>(null);
  const status = useRef<HTMLDivElement>(null);
  const isRunning = running !== null;

  const closeSession = (): void => {
    session.current?.close();
    session.current = null;
  };
  useEffect(() => () => session.current?.close(), []);

  // While PDFs are being copied, leaving the page would stop it half way (restoring again finishes it): Chrome asks first.
  useEffect(() => {
    if (!isRunning) return;
    const ask = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', ask);
    return () => removeEventListener('beforeunload', ask);
  }, [isRunning]);

  // After the owner says Restore, its progress, its result and the indexing come into view under the button (the section is the last on
  // the page), until the indexing is done.
  const follow = useRef(false);
  const indexingActive = indexing?.active ?? false;
  useEffect(() => {
    if (!follow.current) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The section's end, so the page's section list (which follows the scrolling) names Restore too.
    const target = status.current?.closest('section') ?? status.current;
    target?.scrollIntoView({ block: 'end', behavior: reduce ? 'auto' : 'smooth' });
    if (!isRunning && indexing !== null && !indexingActive) follow.current = false;
  }, [isRunning, last, stopped, indexing, indexingActive]);
  // A restore with nothing to index stops following a little after its result.
  const activeNow = useRef(false);
  activeNow.current = indexingActive;
  const stopFollowingSoon = (): void => {
    setTimeout(() => {
      if (!activeNow.current) follow.current = false;
    }, FOLLOW_AFTER_MS);
  };

  const pick = async (): Promise<void> => {
    let picked;
    try {
      picked = await pickBackupFolder(); // first: the picker needs the click that is still fresh
    } catch {
      notify('Couldn’t open the folder picker. Try again.');
      return;
    }
    if (picked.kind === 'unsupported') notify('This browser can’t choose a folder.');
    if (picked.kind !== 'picked') return;
    closeSession();
    const folderName = picked.folder.name;
    const s = openRestore(picked.folder);
    session.current = s;
    setStopped(null);
    setDialog({ stage: 'checking', folderName });
    const preview = await s.preview;
    if (session.current !== s) return; // cancelled meanwhile
    setDialog(preview.ok ? { stage: 'preview', folderName, preview } : { stage: 'refused', folderName, reason: preview.reason, message: preview.message });
  };

  const cancel = (): void => {
    closeSession();
    setDialog(null);
  };

  const restore = async (): Promise<void> => {
    const s = session.current;
    if (s === null) return;
    setDialog(null);
    forgetIndexing();
    follow.current = true;
    setRunning({ step: 'merging' });
    const answer = await s.apply(setRunning);
    if (session.current === s) closeSession();
    stopFollowingSoon();
    if (!answer.ok) {
      setRunning(null);
      setStopped(answer.message);
      return;
    }
    const record = await keepLastRestore(answer.outcome);
    setRunning(null);
    setLast(record);
    notify('Restore finished');
  };

  const busy = running !== null || dialog !== null;
  const lines = last === null ? [] : outcomeLines(last);

  return (
    <SettingsSection
      id="restore"
      title="Restore"
      intro="Brings back your library, your PDFs and your notes from a backup folder, on this computer or on a new one. Nothing you have now is deleted."
    >
      <div className={styles.rows}>
        <SettingsRow
          label="Restore from a backup folder"
          value="Choose the folder that holds your backup. You see what is in it before anything changes."
          actions={<TextButton label="Restore from backup" variant="tonal" disabled={busy} onClick={() => void pick()} />}
        />

        <div ref={status} className={styles.status}>
          {running !== null && (
            <div className={styles.row} role="status">
              <span className={styles.label}>Restoring…</span>
              <span className={styles.value}>{runningWords(running)}</span>
              <Bar label="Restoring" done={running.step === 'copying' ? running.done : null} total={running.step === 'copying' ? running.total : 0} />
            </div>
          )}

          {stopped !== null && (
            <div className={styles.row} role="alert">
              <span className={styles.label}>The restore stopped</span>
              <span className={`${styles.value} ${styles.attention}`}>{stopped}</span>
            </div>
          )}

          {running === null && last !== null && (
            <div className={styles.row} role="status">
              <span className={styles.label}>Last restore · {restoredOn(last.at)}</span>
              {lines.map((line) => (
                <span key={line} className={styles.value}>
                  {line}
                </span>
              ))}
            </div>
          )}

          {indexing !== null && (
            <div className={styles.row} role="status">
              <span className={styles.label}>Making the text searchable</span>
              {indexing.active ? (
                <>
                  <span className={styles.value}>{indexingWords(indexing)}. You can keep reading meanwhile.</span>
                  <Bar label="Indexing" done={indexing.done} total={indexing.total} />
                </>
              ) : (
                <span className={styles.value}>
                  Done. The text of {indexing.total - indexing.failed} {indexing.total - indexing.failed === 1 ? 'reading' : 'readings'} can be searched again.
                </span>
              )}
              {indexing.failed > 0 && (
                <span className={styles.value}>
                  The text of {indexing.failed} {indexing.failed === 1 ? 'reading' : 'readings'} couldn’t be read. {indexing.failed === 1 ? 'It' : 'They'} may need a password.
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <RestoreDialog
        state={dialog}
        onCancel={cancel}
        onRestore={() => void restore()}
        onChooseAgain={() => {
          cancel();
          void pick();
        }}
      />
    </SettingsSection>
  );
}
