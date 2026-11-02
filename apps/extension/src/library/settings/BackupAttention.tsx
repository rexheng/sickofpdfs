// The backup needs the owner: a pill in the library's top bar on every page (plan S13, "the library shows 'Backup is waiting. Click to
// allow.'"). One click asks Chrome to allow the folder again; when Chrome has the owner's answer the backup runs at once.
// A backup that was held on purpose (it would have lost something, R86) shows "Backup needs a look". Its click opens a small card
// with the reason, "Not now" and "Back up anyway", so a hold can be released from any library page (Settings, S14, hosts the same
// choice in its Backup section).
import { Icon, Popover } from '@sop/ui';
import { useContext, useState } from 'react';
import { backupClient } from '../../backup/client';
import { ANYWAY_MESSAGES, HELD_MESSAGES, WAITING_MESSAGE } from '../../backup/status';
import { LibraryContext } from '../app/context';
import styles from './BackupAttention.module.css';
import { useBackupStatus } from './use-backup';

const HELD_PILL = 'Backup needs a look';
const HELD_TITLE = 'Backup is on hold';

export function BackupAttention() {
  const status = useBackupStatus();
  const library = useContext(LibraryContext);
  const [open, setOpen] = useState(false);
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

  if (status.phase === 'held' && status.held !== null) {
    const held = status.held;
    return (
      <Popover
        open={open}
        onOpenChange={setOpen}
        title={HELD_TITLE}
        trigger={
          <button type="button" className={styles.pill} aria-haspopup="dialog">
            <Icon name="error" size={20} />
            <span>{HELD_PILL}</span>
          </button>
        }
        actions={[
          { label: 'Not now', onClick: () => setOpen(false) },
          {
            label: 'Back up anyway',
            primary: true,
            onClick: () => {
              setOpen(false);
              backupClient.backUpNow({ force: true });
              library?.notify({ text: 'Backing up anyway.' });
            },
          },
        ]}
      >
        <p>{HELD_MESSAGES[held]}</p>
        <p>{ANYWAY_MESSAGES[held]}</p>
      </Popover>
    );
  }

  return null;
}
