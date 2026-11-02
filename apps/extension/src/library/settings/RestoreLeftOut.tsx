// The Notes page's line about the last restore (R88, S17): readings the owner removed here for good (Forget, the Trash purge) were left
// out of it, with their notes, even though the backup still held them. It says how many, so a note that did not come back is never a
// mystery, and it goes when the owner says OK. Mounted at the top of Notes (pages/Notes/NotesPage.tsx).
import { Icon, TextButton } from '@sop/ui';
import { useEffect, useState } from 'react';
import { leftOutSeen, onLastRestore, type RestoreRecord } from '../../backup/restore-client';
import styles from './RestoreLeftOut.module.css';

export function RestoreLeftOut() {
  const [last, setLast] = useState<RestoreRecord | null>(null);
  useEffect(() => onLastRestore(setLast), []);
  if (last === null || last.forgotten === 0 || last.leftOutSeen) return null;
  const n = last.forgotten;
  return (
    <div className={styles.note} role="status">
      <Icon name="info" size={20} />
      <span className={styles.text}>
        {n} {n === 1 ? 'reading' : 'readings'} you removed here {n === 1 ? 'was' : 'were'} left out of your last restore, so {n === 1 ? 'its' : 'their'} notes
        are not here.
      </span>
      <TextButton label="OK" onClick={() => void leftOutSeen()} />
    </div>
  );
}
