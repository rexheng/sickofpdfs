// The backup's status for a React page: the record in `sop-handles`, read again whenever the writer says it changed.
import { useEffect, useState } from 'react';
import { backupClient } from '../../backup/client';
import type { BackupStatus } from '../../backup/status';

/** The status, or null until it has been read. */
export function useBackupStatus(): BackupStatus | null {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  useEffect(() => backupClient.onStatus(setStatus), []);
  return status;
}

/** The time now, read again every `everyMs`, so "today at 2:05 am" stays true while the page is open. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
