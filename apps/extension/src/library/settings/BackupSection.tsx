// Settings → Backup (plan S13). The folder, the last backup in plain words, and the few buttons: Choose folder, Allow, Back up now,
// Export library. S14's Settings page lists this component in its `SETTINGS_SECTIONS` registry.
//
// This file never reaches the secrets store (the import boundary in eslint.config.mjs bars it, though the folder it sits in is
// otherwise allowed to).
import { describeBackup } from '@sop/core';
import { Dialog, TextButton } from '@sop/ui';
import { useContext, useState } from 'react';
import { backupClient } from '../../backup/client';
import { ANYWAY_MESSAGES, type BackupStatus, droppedLine, retiredLine, summaryLabel, summaryLine, unreadableLine } from '../../backup/status';
import { LibraryContext } from '../app/context';
import styles from './BackupSection.module.css';
import { useBackupStatus, useNow } from './use-backup';

type Confirm = 'turn-off' | 'back-up-anyway' | null;

function useNotify(): (text: string) => void {
  const library = useContext(LibraryContext);
  return (text) => library?.notify({ text });
}

/** What the folder holds, in the restore dialog's words: "12 readings, 340 notes, 9 PDFs". */
const holds = (s: BackupStatus): string | null => (s.counts === null ? null : describeBackup({ counts: s.counts }));

export function BackupSection() {
  const status = useBackupStatus();
  const now = useNow();
  const notify = useNotify();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [exporting, setExporting] = useState(false);

  if (status === null) return <section className={styles.section} aria-busy="true" />;

  const choose = async (): Promise<void> => {
    try {
      const result = await backupClient.chooseFolder();
      if (result === 'unsupported') notify('This browser can’t choose a folder.');
      else if (result === 'chosen') notify('Backup folder chosen. The first backup is starting.');
    } catch {
      notify('Couldn’t open the folder picker. Try again.');
    }
  };

  const allow = async (): Promise<void> => {
    try {
      if ((await backupClient.allow()) === 'refused') notify('Backup is still waiting. Choose Allow when Chrome asks.');
    } catch {
      notify('Couldn’t ask Chrome. Try again.');
    }
  };

  const finishRemovals = async (): Promise<void> => {
    try {
      const result = await backupClient.finishRemovals();
      if (result === 'done') notify('The waiting removals are done.');
      else if (result === 'dropped') notify('The old backup folder can’t be found any more, so its waiting removal was dropped.');
      else notify('Some removals are still waiting. They are tried again at each backup.');
    } catch {
      notify('Couldn’t reach the folder. Try again.');
    }
  };

  const exportZip = async (): Promise<void> => {
    setExporting(true);
    try {
      if ((await backupClient.exportZip()) === 'saved') notify('Your library is saved as a zip file.');
    } catch {
      notify('Couldn’t save the zip file. Try again.');
    } finally {
      setExporting(false);
    }
  };

  const chosen = status.phase !== 'off';
  const attention = status.phase === 'waiting' || status.phase === 'held' || status.phase === 'failed';
  const contents = holds(status);
  const pending = status.scrubsPending;

  // Removals that were given up (R88): the old folder no longer exists, or they waited 30 days. Said plainly until the owner clicks OK.
  const droppedRows = status.dropped.map((d, i) => (
    <div key={`dropped-${d.at}-${i}`} className={styles.row}>
      <div className={styles.text}>
        <span className={styles.label}>Removing PDFs you forgot</span>
        <span className={styles.value}>{droppedLine(d)}</span>
      </div>
      <div className={styles.actions}>
        <TextButton label="OK" onClick={() => void backupClient.clearDropped()} />
      </div>
    </div>
  ));

  // Removals still waiting for folders the owner moved away from (Change folder, Turn off): said plainly, with "Try now".
  const retiredRows = status.retired.map((r) => (
    <div key={r.id} className={styles.row}>
      <div className={styles.text}>
        <span className={styles.label}>Removing PDFs you forgot</span>
        <span className={styles.value}>{retiredLine(r)} It is tried again at each backup.</span>
      </div>
      <div className={styles.actions}>
        <TextButton label="Try now" onClick={() => void finishRemovals()} />
      </div>
    </div>
  ));

  const exportRow = (
    <div className={styles.row}>
      <div className={styles.text}>
        <span className={styles.label}>Export library</span>
        <span className={styles.value}>Saves your library, PDFs and notes as one zip file.</span>
      </div>
      <div className={styles.actions}>
        <TextButton label={exporting ? 'Saving…' : 'Export library'} disabled={exporting} onClick={() => void exportZip()} />
      </div>
    </div>
  );

  return (
    <section className={styles.section} aria-labelledby="backup-title">
      <h2 id="backup-title" className={styles.title}>
        Backup
      </h2>
      <p className={styles.intro}>
        Keeps a copy of your library, your PDFs and your notes in a folder you choose. It runs every night, and after you take notes. Choose a folder in
        Google Drive for desktop or OneDrive to keep the copy safe away from this computer.
      </p>

      {!chosen && (
        <div className={styles.first}>
          <TextButton label="Choose folder" variant="tonal" onClick={() => void choose()} />
        </div>
      )}

      <div className={styles.rows}>
        {chosen && (
          <>
            <div className={styles.row}>
              <div className={styles.text}>
                <span className={styles.label}>Folder</span>
                <span className={styles.value}>{status.folderName ?? 'Chosen'}</span>
              </div>
              <div className={styles.actions}>
                <TextButton label="Change folder" onClick={() => void choose()} />
                <TextButton label="Turn off" onClick={() => setConfirm('turn-off')} />
              </div>
            </div>

            <div className={styles.row}>
              <div className={styles.text} role="status">
                <span className={styles.label}>{summaryLabel(status)}</span>
                <span className={attention ? `${styles.value} ${styles.attention}` : styles.value}>{summaryLine(status, now)}</span>
                {status.phase === 'idle' && contents !== null && <span className={styles.value}>{contents}</span>}
                {status.phase === 'idle' && status.message !== null && <span className={styles.value}>{status.message}</span>}
                {status.phase === 'held' && status.held !== null && <span className={styles.value}>{ANYWAY_MESSAGES[status.held]}</span>}
              </div>
              <div className={styles.actions}>
                {status.phase === 'waiting' && <TextButton label="Allow" variant="tonal" onClick={() => void allow()} />}
                {status.phase === 'held' && <TextButton label="Back up anyway" onClick={() => setConfirm('back-up-anyway')} />}
                {(status.phase === 'idle' || status.phase === 'failed') && (
                  <TextButton label={status.phase === 'failed' ? 'Try again' : 'Back up now'} variant="tonal" onClick={() => backupClient.backUpNow()} />
                )}
              </div>
            </div>

            {pending > 0 && (
              <div className={styles.row}>
                <div className={styles.text}>
                  <span className={styles.label}>Removing PDFs you forgot</span>
                  <span className={styles.value}>
                    {pending === 1 ? 'One PDF you forgot is' : `${pending} PDFs you forgot are`} still in your backup folder. {pending === 1 ? 'It' : 'They'} will be
                    removed at the next backup.
                  </span>
                  {status.unreadable.length > 0 && <span className={`${styles.value} ${styles.attention}`}>{unreadableLine(status.unreadable)}</span>}
                </div>
              </div>
            )}
          </>
        )}
        {retiredRows}
        {droppedRows}
        {exportRow}
      </div>

      <Dialog
        open={confirm === 'turn-off'}
        title="Turn off backup?"
        onOpenChange={(open) => !open && setConfirm(null)}
        actions={[
          { label: 'Cancel', onClick: () => setConfirm(null) },
          {
            label: 'Turn off',
            primary: true,
            onClick: () => {
              setConfirm(null);
              void backupClient.turnOff();
            },
          },
        ]}
      >
        <p className={styles.dialogText}>
          Backups stop. The files already in the folder stay where they are.
          {pending > 0 ? ' The PDFs you forgot are removed from it first.' : ''}
        </p>
      </Dialog>

      <Dialog
        open={confirm === 'back-up-anyway'}
        title="Back up anyway?"
        onOpenChange={(open) => !open && setConfirm(null)}
        actions={[
          { label: 'Cancel', onClick: () => setConfirm(null) },
          {
            label: 'Back up anyway',
            primary: true,
            onClick: () => {
              setConfirm(null);
              backupClient.backUpNow({ force: true });
            },
          },
        ]}
      >
        <p className={styles.dialogText}>
          {status.held === 'other-library' || status.held === 'unreadable'
            ? 'What is in this folder now will be replaced by a backup of this library.'
            : status.held === 'notes-missing'
              ? 'Your library is backed up as it is now. The daily copies in the folder keep the missing notes for a week.'
              : 'Your library is backed up as it is now. The copies of the missing readings stay in the folder.'}
        </p>
      </Dialog>
    </section>
  );
}
