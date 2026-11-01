// The backup needs the owner: a pill in the library's top bar on every page (plan S13, "the library shows 'Backup is waiting. Click to
// allow.'"). One click asks Chrome to allow the folder again; when Chrome has the owner's answer the backup runs at once.
// A backup that was held on purpose (it would have lost something) shows a pill that opens Settings, where the choice is.
import { Icon } from '@sop/ui';
import { useContext } from 'react';
import { backupClient } from '../../backup/client';
import { WAITING_MESSAGE } from '../../backup/status';
import { LibraryContext } from '../app/context';
import styles from './BackupAttention.module.css';
import { useBackupStatus } from './use-backup';

export function BackupAttention() {
  const status = useBackupStatus();
  const library = useContext(LibraryContext);
  if (status === null) return null;

  if (status.phase === 'waiting') {
    return (
      <button
        type="button"
        className={styles.pill}
        title={WAITING_MESSAGE}
        onClick={() => {
          backupClient.allow().then(
            (result) => {
              if (result === 'refused') library?.notify({ text: 'Backup is still waiting. Choose Allow when Chrome asks.' });
            },
            () => library?.notify({ text: 'Couldn’t ask Chrome. Open Settings to try again.' }),
          );
        }}
      >
        <Icon name="error" size={20} />
        <span>{WAITING_MESSAGE}</span>
      </button>
    );
  }

  if (status.phase === 'held') {
    return (
      <a className={styles.pill} href="#/settings" title={status.message ?? undefined}>
        <Icon name="error" size={20} />
        <span>Backup needs a look</span>
      </a>
    );
  }

  return null;
}
