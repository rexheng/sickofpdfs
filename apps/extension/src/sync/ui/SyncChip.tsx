// The library's sync line in the top bar (CL11, plan g5: "The library says how many items are not yet synced"). Plain words, and
// only when there is something to say:
//   - restoring after a reinstall: "Restoring 3 of 12";
//   - changes still on this computer only: "4 not yet synced" (offline: "Offline · 4 not yet synced");
//   Every chip opens Settings → Cloud, where "Sync now" is.
//   - sync has stopped (signed out, refused): the error pill "Sync has stopped", which opens Settings;
//   - all synced, or no cloud connected: nothing at all.
// Settings → Cloud (CloudSettings.tsx, CL12) has the full screens; this chip is the always-visible part, and it opens them.
import { Chip, Icon } from '@sop/ui';
import { CLOUD_SETTINGS_HASH } from '../status';
import styles from './SyncChip.module.css';
import { useSyncStatus } from './use-sync-status';

const STOPPED = 'Sync has stopped';


/** "1 not yet synced", "12 not yet synced". */
export const notYetSynced = (n: number): string => `${n.toLocaleString()} not yet synced`;

export function SyncChip() {
  const s = useSyncStatus();
  if (s === null || s.state === 'off') return null;
  const openSettings = () => (location.hash = CLOUD_SETTINGS_HASH);

  if (s.state === 'stopped' || s.state === 'signed-out') {
    return (
      <button type="button" className={styles.stopped} title={`${s.message ?? STOPPED}${s.unsynced > 0 ? ` ${notYetSynced(s.unsynced)}: these changes are safe on this computer.` : ''}`} onClick={openSettings}>
        <Icon name="error" size={20} />
        <span>{STOPPED}</span>
      </button>
    );
  }
  if (s.restoring !== null && s.restoring.total > 0) {
    return <Chip tone="neutral" icon="refresh" label={`Restoring ${Math.min(s.restoring.done + 1, s.restoring.total)} of ${s.restoring.total}`} tooltip="Bringing back your library from your cloud." onClick={openSettings} />;
  }
  if (s.unsynced > 0) {
    const label = notYetSynced(s.unsynced);
    return (
      <Chip
        tone="neutral"
        icon="backup"
        label={s.state === 'offline' ? 'Offline' : label}
        detail={s.state === 'offline' ? ` · ${label}` : undefined}
        tooltip={s.message ?? 'These changes are saved on this computer. Click to see sync.'}
        onClick={openSettings}
      />
    );
  }
  return null;
}
