// The sync status for a page (CL11; CL12's Settings → Cloud uses it too). Null until the engine answers, and while no engine runs.
import { useEffect, useState } from 'react';
import { subscribeSyncStatus, type SyncEngineStatus } from '../status';

export function useSyncStatus(): SyncEngineStatus | null {
  const [status, setStatus] = useState<SyncEngineStatus | null>(null);
  useEffect(() => subscribeSyncStatus(setStatus), []);
  return status;
}
