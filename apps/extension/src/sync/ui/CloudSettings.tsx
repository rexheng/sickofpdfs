// Settings → Cloud (plan CL12, spec R109). One section of the Settings page's registry (library/settings/sections.ts), at
// `library.html#/settings/cloud`. The library's sync chip, its "Sync has stopped" pill and the toolbar menu's line open it.
//
// For everyone: "Cloud sync is coming", with "Join the waitlist", which opens the site's waitlist in a new tab.
// Under it, a small "Connect my own server" link. For the owner, that holds:
//   - the server address and Connect (Chrome's sign-in window opens, and the owner signs in with GitHub);
//   - the status line, in plain words: "Everything is synced", "Saved · 3 not yet synced", "Restoring 2 of 12", "Offline",
//     "Daily limit reached", "Sync has stopped" and why;
//   - Sync now, the devices that sync, Sign out;
//   - what syncs, and what never leaves this computer.
//
// Network (R109): opening this section sends nothing anywhere. It asks the service worker and the sync engine on this computer
// only. The first request leaves when the owner clicks Join the waitlist (a new tab) or Connect. The devices list is asked of
// the connected server only while signed in.
import { waitlistUrl } from '@sop/core';
import { serverOrigin } from '@sop/core/sync-client';
import { Icon, type IconName, TextButton, TextField } from '@sop/ui';
import { useCallback, useEffect, useState } from 'react';
import { formatDate } from '../../library/components/format';
import { SettingsGroup, SettingsNote, SettingsRow, SettingsSection } from '../../library/pages/Settings/SettingsSection';
import { type CloudDeviceInfo, type CloudFailure, cloudDevices, cloudSignIn, cloudSignOut, type CloudStatus, cloudStatus } from '../../shared/cloud-messages';
import { type SyncEngineStatus, syncNow } from '../status';
import styles from './CloudSettings.module.css';
import { notYetSynced } from './SyncChip';
import { useSyncStatus } from './use-sync-status';

/** The owner's own server (R109). The field starts with it; any other https address works too. */
export const OWNER_SERVER = 'https://sickofpdfs.rexheng-policy.workers.dev';

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/** "today at 10:42", "on 3 Nov". */
function whenWords(t: number, now = Date.now()): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return t >= today.getTime() ? `today at ${TIME.format(t)}` : `on ${formatDate(t, now)}`;
}

/** Plain words for a Connect or Sign in that did not finish. */
function failureWords(reason: CloudFailure, message: string): string {
  switch (reason) {
    case 'cancelled':
      return 'The sign-in window was closed before you finished. Try again.';
    case 'bad-request':
      return 'Check the address. It must start with https://.';
    case 'refused':
      return 'The server said no. Sign in with the GitHub account that owns this server.';
    case 'offline':
      return 'Couldn’t reach that server. Check the address and your internet, then try again.';
    case 'not-allowed':
      return message;
    default:
      return 'The sign-in didn’t finish. Try again.';
  }
}

export interface StatusLine {
  icon: IconName;
  tone: 'ok' | 'busy' | 'problem';
  label: string;
  detail: string;
}

/** The status line for a connected server: what sync is doing, in one short label and one or two plain sentences. */
export function statusLine(cloud: CloudStatus, s: SyncEngineStatus | null, now = Date.now()): StatusLine {
  const safe = 'Your changes are safe on this computer.';
  if (!cloud.signedIn || s?.state === 'signed-out') {
    return { icon: 'error', tone: 'problem', label: 'Sync has stopped', detail: `You’re signed out. ${safe} Sign in to sync them.` };
  }
  if (s === null) return { icon: 'refresh', tone: 'busy', label: 'Connected', detail: 'Checking sync…' };
  const waiting = s.unsynced > 0 ? ` ${notYetSynced(s.unsynced)}.` : '';
  if (s.state === 'stopped') return { icon: 'error', tone: 'problem', label: 'Sync has stopped', detail: `${s.message ?? 'Your cloud refused the last change.'} ${safe}${waiting}` };
  if (s.restoring !== null && s.restoring.total > 0) {
    const n = Math.min(s.restoring.done + 1, s.restoring.total);
    return { icon: 'refresh', tone: 'busy', label: `Restoring ${n} of ${s.restoring.total}`, detail: 'Bringing back your library from your cloud. You can keep reading.' };
  }
  if (s.state === 'offline') {
    return { icon: 'cloud_off', tone: 'busy', label: s.unsynced > 0 ? `Offline · ${notYetSynced(s.unsynced)}` : 'Offline', detail: `${safe} Sync starts again when you’re back online.` };
  }
  if (s.state === 'quota') {
    return { icon: 'schedule', tone: 'busy', label: 'Daily limit reached', detail: s.message ?? 'Your cloud has done enough work for today. Notes still sync. The rest syncs tomorrow.' };
  }
  const text = s.textWaiting ? ' Page text waits for tomorrow, because of your cloud’s daily limit. Notes still sync.' : '';
  if (s.unsynced > 0) {
    return { icon: 'backup', tone: 'busy', label: `Saved · ${notYetSynced(s.unsynced)}`, detail: `${s.state === 'syncing' ? 'Syncing now.' : 'Saved on this computer. They sync within a minute.'}${text}` };
  }
  if (s.state === 'syncing') return { icon: 'refresh', tone: 'busy', label: 'Syncing…', detail: `Checking your cloud for changes.${text}` };
  return {
    icon: 'cloud_done',
    tone: 'ok',
    label: 'Everything is synced',
    detail: `${s.lastSyncAt !== null ? `Last synced ${whenWords(s.lastSyncAt, now)}.` : 'Your library and notes are in your cloud.'}${text}`,
  };
}

type Action = { phase: 'idle' } | { phase: 'busy'; what: 'connect' | 'signout' | 'remove' } | { phase: 'failed'; message: string };

export function CloudSettings() {
  if (chrome.extension.inIncognitoContext) {
    return (
      <SettingsSection id="cloud" title="Cloud" intro="Keep your library and notes on all your devices.">
        <SettingsNote icon={<Icon name="lock" size={20} />}>Cloud sync isn’t available in an Incognito window.</SettingsNote>
      </SettingsSection>
    );
  }
  return <CloudSection />;
}

function CloudSection() {
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [own, setOwn] = useState(false);
  const [server, setServer] = useState(OWNER_SERVER);
  const [action, setAction] = useState<Action>({ phase: 'idle' });
  const sync = useSyncStatus();

  // What this computer knows: whether a server is connected and signed in. A message to the service worker; no request.
  const readStatus = useCallback(async () => {
    const r = await cloudStatus();
    if (r.ok) {
      setCloud(r.status);
      if (r.status.server !== null) setServer(r.status.server);
    } else setCloud({ connected: false, server: null, signedIn: false, forgetsWaiting: 0 });
  }, []);
  useEffect(() => {
    void readStatus();
  }, [readStatus]);
  // a sign-in that ends on the server shows up here as soon as the engine says so
  const signedOutNow = sync?.state === 'signed-out';
  useEffect(() => {
    if (signedOutNow) void readStatus();
  }, [signedOutNow, readStatus]);

  const signIn = async (address: string) => {
    const origin = serverOrigin(address);
    if (origin === null) {
      setAction({ phase: 'failed', message: 'Check the address. It must start with https://.' });
      return;
    }
    setAction({ phase: 'busy', what: 'connect' });
    const r = await cloudSignIn(origin);
    if (r.ok) {
      setCloud(r.status);
      setAction({ phase: 'idle' });
      syncNow();
    } else {
      setAction({ phase: 'failed', message: failureWords(r.reason, r.message) });
      void readStatus();
    }
  };

  const signOut = async (disconnect: boolean) => {
    setAction({ phase: 'busy', what: disconnect ? 'remove' : 'signout' });
    const r = await cloudSignOut(disconnect);
    if (r.ok) setCloud(r.status);
    setAction(r.ok ? { phase: 'idle' } : { phase: 'failed', message: 'Couldn’t sign out. Try again.' });
    if (disconnect) setServer(OWNER_SERVER);
  };

  if (cloud === null) {
    return (
      <SettingsSection id="cloud" title="Cloud" intro="Keep your library and notes on all your devices.">
        <div className={styles.loading} />
      </SettingsSection>
    );
  }

  const connected = cloud.connected;
  return (
    <SettingsSection id="cloud" title="Cloud" intro="Keep your library and notes on all your devices. Until you turn it on, everything stays on this computer.">
      {!connected && <Waitlist />}

      {!connected && !own && (
        <button type="button" className={styles.ownLink} onClick={() => setOwn(true)}>
          Connect my own server
        </button>
      )}

      {!connected && own && (
        <SettingsGroup
          id="cloud-own"
          title="Your own server"
          description="If you run the sickofpdfs server on your own Cloudflare account, connect it here. Then sign in with the GitHub account that owns it."
        >
          <div className={styles.entry}>
            <div className={styles.entryLine}>
              <TextField
                className={styles.serverField}
                label="Server address"
                placeholder="https://"
                value={server}
                invalid={action.phase === 'failed'}
                readOnly={action.phase === 'busy'}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                aria-describedby="cloud-own-status"
                onChange={(v) => {
                  setServer(v);
                  if (action.phase === 'failed') setAction({ phase: 'idle' });
                }}
                onEnter={() => void signIn(server)}
              />
              <TextButton variant="tonal" label={action.phase === 'busy' ? 'Signing in…' : 'Connect'} disabled={action.phase === 'busy' || server.trim() === ''} onClick={() => void signIn(server)} />
              <TextButton
                label="Cancel"
                disabled={action.phase === 'busy'}
                onClick={() => {
                  setOwn(false);
                  setAction({ phase: 'idle' });
                }}
              />
            </div>
            <ActionLine id="cloud-own-status" action={action} hint="Connect opens a sign-in window. Nothing is sent before you press it." />
          </div>
        </SettingsGroup>
      )}

      {connected && cloud.server !== null && (
        <Connected cloud={cloud} sync={sync} action={action} onSignIn={() => void signIn(cloud.server ?? server)} onSignOut={(d) => void signOut(d)} />
      )}

      {(connected || own) && <WhatSyncs />}
    </SettingsSection>
  );
}

/** "Cloud sync is coming": for everyone. The site's waitlist opens in a new tab, only when clicked. */
function Waitlist() {
  const url = waitlistUrl();
  return (
    <div className={styles.waitlist}>
      <span className={styles.waitlistIcon} aria-hidden="true">
        <Icon name="cloud_done" size={24} />
      </span>
      <div className={styles.waitlistText}>
        <h3 className={styles.waitlistTitle}>Cloud sync is coming</h3>
        <p className={styles.waitlistBody}>Soon your library and notes will be on your phone and your other computers too. Join the waitlist, and we’ll email you when it’s ready.</p>
      </div>
      {url !== null && <TextButton variant="tonal" icon="open_in_new" label="Join the waitlist" onClick={() => void chrome.tabs.create({ url })} />}
    </div>
  );
}

function ActionLine({ id, action, hint }: { id: string; action: Action; hint: string | null }) {
  return (
    <div id={id} className={styles.status} role="status">
      {action.phase === 'busy' && action.what === 'connect' && <span className={styles.hint}>Finish signing in, in the window that opened.</span>}
      {action.phase === 'failed' && (
        <span className={styles.error}>
          <Icon name="error" size={20} />
          <span>{action.message}</span>
        </span>
      )}
      {action.phase === 'idle' && hint !== null && <span className={styles.hint}>{hint}</span>}
    </div>
  );
}

function Connected({
  cloud,
  sync,
  action,
  onSignIn,
  onSignOut,
}: {
  cloud: CloudStatus;
  sync: SyncEngineStatus | null;
  action: Action;
  onSignIn(this: void): void;
  onSignOut(this: void, disconnect: boolean): void;
}) {
  const line = statusLine(cloud, sync);
  const busy = action.phase === 'busy';
  const signedIn = cloud.signedIn && sync?.state !== 'signed-out';
  const syncing = sync?.state === 'syncing';
  const host = cloud.server === null ? '' : new URL(cloud.server).host;
  return (
    <>
      <SettingsGroup id="cloud-sync" title="Sync">
        <SettingsRow
          icon={<Icon name={line.icon} size={20} className={line.tone === 'problem' ? styles.iconProblem : line.tone === 'ok' ? styles.iconOk : undefined} />}
          label={<span className={line.tone === 'problem' ? styles.labelProblem : undefined}>{line.label}</span>}
          value={line.detail}
          actions={
            signedIn ? (
              <TextButton label={syncing ? 'Syncing…' : 'Sync now'} icon="refresh" disabled={syncing || busy} onClick={syncNow} />
            ) : (
              <TextButton variant="tonal" label={busy && action.what === 'connect' ? 'Signing in…' : 'Sign in'} disabled={busy} onClick={onSignIn} />
            )
          }
        />
        <SettingsRow
          icon={<Icon name="link" size={20} />}
          label="Your server"
          value={host}
          actions={
            signedIn ? (
              <TextButton label={busy && action.what === 'signout' ? 'Signing out…' : 'Sign out'} icon="logout" disabled={busy} onClick={() => onSignOut(false)} />
            ) : (
              <TextButton label={busy && action.what === 'remove' ? 'Removing…' : 'Remove server'} disabled={busy} onClick={() => onSignOut(true)} />
            )
          }
        />
      </SettingsGroup>
      <ActionLine id="cloud-sync-status" action={action} hint={null} />
      {signedIn && <Devices lastSyncAt={sync?.lastSyncAt ?? null} />}
      {!signedIn && (
        <SettingsNote icon={<Icon name="info" size={20} />}>
          Signing out stops sync on this computer only. Your library, notes and cloud stay as they are. Remove server to forget the address too.
        </SettingsNote>
      )}
    </>
  );
}

const DEVICE_ICON: Record<string, IconName> = { extension: 'public', android: 'devices', ios: 'devices', web: 'language' };

/** The devices that sync, asked of the connected server (signed in only), again after each sync. */
function Devices({ lastSyncAt }: { lastSyncAt: number | null }) {
  const [devices, setDevices] = useState<CloudDeviceInfo[] | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    void cloudDevices().then((r) => {
      if (live) setDevices(r.ok ? r.devices : 'failed');
    });
    return () => {
      live = false;
    };
  }, [lastSyncAt]);
  if (devices === null) return null;
  return (
    <SettingsGroup id="cloud-devices" title="Devices" description="The computers and phones that sync with your cloud.">
      {devices === 'failed' && <SettingsRow icon={<Icon name="cloud_off" size={20} />} label="Couldn’t load your devices" value="Your server didn’t answer. Sync now tries again." />}
      {devices !== 'failed' && devices.length === 0 && <SettingsRow icon={<Icon name="devices" size={20} />} label="No devices yet" value="This computer appears here after its first sync." />}
      {devices !== 'failed' &&
        devices.map((d) => (
          <SettingsRow
            key={d.id}
            icon={<Icon name={DEVICE_ICON[d.kind] ?? 'devices'} size={20} />}
            label={d.thisDevice ? `${d.name} (this computer)` : d.name}
            value={d.lastSeenAt !== null ? `Last synced ${whenWords(d.lastSeenAt)}` : `Added ${whenWords(d.createdAt)}`}
          />
        ))}
    </SettingsGroup>
  );
}

const SYNCS: readonly string[] = [
  'Learning PDFs you save to your library',
  'Your highlights, marks and comments',
  'Stars, tags, courses and page order',
  'Page text, so search works on every device',
];
const STAYS: readonly string[] = [
  'Receipts, bills and other private PDFs',
  'PDFs you open but don’t save',
  'Readings you saved even though they looked private',
  'Comments you haven’t finished (drafts)',
  'Your Claude key and your backup folder',
];

/** What syncs, and what never leaves this computer, in two short lists. */
function WhatSyncs() {
  return (
    <SettingsGroup id="cloud-what" title="What syncs" description="Only your learning library goes to your cloud. Everything private stays here.">
      <div className={styles.lists}>
        <div>
          <p className={styles.listHead}>Syncs to your cloud</p>
          <ul className={styles.list} aria-label="Syncs to your cloud">
            {SYNCS.map((t) => (
              <li key={t} className={styles.item}>
                <Icon name="check" size={20} className={styles.iconOk} />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className={styles.listHead}>Never leaves this computer</p>
          <ul className={styles.list} aria-label="Never leaves this computer">
            {STAYS.map((t) => (
              <li key={t} className={styles.item}>
                <Icon name="lock" size={20} className={styles.iconMuted} />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </SettingsGroup>
  );
}
