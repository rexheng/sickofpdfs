// The sync status in the top bar, in plain words: "Loading your library…", "Saving…", "Saved", "Offline, not saved".
// A click on a status that is not "Saved" tries again at once.
import { Icon, type IconName, Tooltip } from '@sop/ui';
import { useSyncExternalStore } from 'react';
import { type SyncStatus, webLibrary } from '../sync/engine';
import styles from './SyncStatus.module.css';

const IDLE: SyncStatus = { state: 'loading', unsynced: 0, lastSyncedAt: null };

function subscribe(cb: () => void): () => void {
  try {
    return webLibrary().sync.subscribe(cb);
  } catch {
    // the library has not started yet: check again shortly
    const t = setInterval(cb, 300);
    return () => clearInterval(t);
  }
}
function snapshot(): SyncStatus {
  try {
    return webLibrary().sync.status();
  } catch {
    return IDLE;
  }
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const notSaved = (n: number) => (n === 1 ? '1 change isn’t saved yet.' : `${n} changes aren’t saved yet.`);

function describe(s: SyncStatus): { icon: IconName; text: string; short: string; help: string; warn: boolean } {
  switch (s.state) {
    case 'loading':
      return { icon: 'refresh', text: 'Loading your library…', short: 'Loading…', help: 'Getting your readings and notes from your cloud.', warn: false };
    case 'saving':
      return { icon: 'refresh', text: 'Saving…', short: 'Saving…', help: 'Sending your change to your cloud.', warn: false };
    case 'saved':
      return { icon: 'cloud_done', text: 'Saved', short: 'Saved', help: 'Everything is saved in your cloud.', warn: false };
    case 'offline':
      return { icon: 'cloud_off', text: s.unsynced > 0 ? 'Offline, not saved' : 'Offline', short: s.unsynced > 0 ? 'Not saved' : 'Offline', help: `${s.unsynced > 0 ? notSaved(s.unsynced) : 'Your cloud can’t be reached.'} Keep this tab open: it tries again when you’re back online.`, warn: s.unsynced > 0 };
    case 'busy':
      return { icon: 'cloud_off', text: s.unsynced > 0 ? 'Not saved yet' : 'Can’t reach your cloud', short: 'Not saved', help: `${s.unsynced > 0 ? notSaved(s.unsynced) : ''} Your cloud is busy. It tries again soon. Click to try now.`, warn: s.unsynced > 0 };
    case 'refused':
      return { icon: 'error', text: 'A change wasn’t saved', short: 'Not saved', help: 'Your cloud refused a change. Reload the page to see what is saved.', warn: true };
    case 'textFailed':
      return {
        icon: 'search_off',
        text: 'Saved · Search not ready yet',
        short: 'Search not ready',
        help: `Your notes are saved. ${s.textProblem === 'quota' ? 'Your cloud reached its daily limit, so the words of a PDF weren’t sent.' : 'Sending the words of a PDF failed.'} Search can’t find them yet. Click to try again.`,
        warn: true,
      };
  }
}

export function SyncStatusChip({ compact = false }: { compact?: boolean }) {
  const status = useSyncStatus();
  const d = describe(status);
  const spinning = status.state === 'loading' || status.state === 'saving';
  const retry = () => {
    try {
      webLibrary().sync.retry();
    } catch {
      // not started
    }
  };
  return (
    <Tooltip label={d.help}>
      <button
        type="button"
        className={`${styles.chip} ${d.warn ? styles.warn : ''}`}
        onClick={status.state === 'saved' || status.state === 'loading' ? undefined : retry}
        aria-live="polite"
        data-sync={status.state}
      >
        <Icon name={d.icon} size={20} className={spinning ? styles.spin : undefined} />
        {!(compact && status.state === 'saved') && <span className={styles.text}>{compact ? d.short : d.text}</span>}
      </button>
    </Tooltip>
  );
}
