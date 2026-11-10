// Settings → Cloud on the phone (R109). For everyone: "Cloud sync is coming" with "Join the waitlist". For the owner: a small
// "Connect my own server" link, with the owner's server filled in. Once connected: where it syncs to, a status line in plain words,
// "Sync now" and "Sign out".
//
// Nothing is sent anywhere until the owner taps Connect (R110). The waitlist opens in the phone's browser, only when tapped.
import { TextButton, TextField } from '@sop/ui';
import { useCallback, useEffect, useState } from 'react';
import type { CloudStatus } from '@ext/shared/cloud-messages';
import { useLibrary } from '@ext/library/app/context';
import { SettingsGroup, SettingsRow, SettingsSection } from '@ext/library/pages/Settings/SettingsSection';
import { syncNow, type SyncEngineStatus } from '@ext/sync/status';
import { useSyncStatus } from '@ext/sync/ui/use-sync-status';
import { navigate } from '../platform/chrome-shim';
import { cloudEvents, cloudStatusHere, signInHere, signOutHere } from '../platform/cloud-broker';
import { OWNER_SERVER, phoneWaitlistUrl } from '../platform/cloud-config';
import styles from './CloudSection.module.css';

/** "just now", "5 minutes ago", "2 hours ago", or the day. */
function ago(at: number, now: number): string {
  const min = Math.round((now - at) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The status line: one short sentence for each state of the engine. */
function statusLine(s: SyncEngineStatus | null, now: number): { text: string; problem: boolean } {
  if (s === null || s.state === 'off') return { text: 'Starting…', problem: false };
  if (s.restoring !== null && s.restoring.total > 0) return { text: `Bringing back your library: ${Math.min(s.restoring.done + 1, s.restoring.total)} of ${s.restoring.total}.`, problem: false };
  const waiting = s.unsynced > 0 ? `${s.unsynced.toLocaleString()} not yet synced. ` : '';
  switch (s.state) {
    case 'syncing':
      return { text: `${waiting}${s.message ?? 'Syncing…'}`, problem: false };
    case 'offline':
      return { text: `${waiting}You are offline. Your changes are safe on this phone and sync when you are back online.`, problem: false };
    case 'quota':
    case 'stopped':
    case 'signed-out':
      return { text: `${waiting}${s.message ?? 'Sync has stopped.'}`, problem: true };
    case 'ok':
      if (s.unsynced > 0) return { text: `${s.unsynced.toLocaleString()} not yet synced.`, problem: false };
      return { text: `Everything is synced.${s.lastSyncAt !== null ? ` Last synced ${ago(s.lastSyncAt, now)}.` : ''}${s.textWaiting && s.message ? ` ${s.message}` : ''}`, problem: false };
  }
}

function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function CloudSection() {
  const { notify } = useLibrary();
  const sync = useSyncStatus();
  const now = useNow();
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [own, setOwn] = useState(false);
  const [server, setServer] = useState(OWNER_SERVER);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const look = useCallback(() => {
    cloudStatusHere().then(setCloud, () => setCloud({ connected: false, server: null, signedIn: false, forgetsWaiting: 0 }));
  }, []);
  useEffect(() => {
    look();
    cloudEvents.addEventListener('changed', look);
    return () => cloudEvents.removeEventListener('changed', look);
  }, [look]);

  const connect = async (address: string) => {
    setBusy(true);
    setProblem(null);
    const r = await signInHere(address);
    setBusy(false);
    if (r.ok) {
      setCloud(r.status);
      setOwn(false);
      notify({ text: 'Connected. Your library is syncing.' });
    } else if (r.reason !== 'cancelled') setProblem(r.message);
  };

  const signOut = async (disconnect: boolean) => {
    setBusy(true);
    try {
      setCloud((await signOutHere(disconnect)).status);
      notify({ text: disconnect ? 'Disconnected. Nothing is sent to your server now.' : 'Signed out. Your library stays on this phone.' });
    } catch {
      notify({ text: 'Couldn’t sign out. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  if (cloud === null) return <section aria-busy="true" />;

  if (!cloud.connected || cloud.server === null) {
    return (
      <SettingsSection id="cloud" title="Cloud" intro="Keep your library and notes the same on your phone, in Chrome and on the web.">
        <div className={styles.coming}>
          <p className={styles.comingTitle}>Cloud sync is coming</p>
          <p className={styles.comingText}>Join the waitlist and we will email you when it is ready.</p>
          <TextButton label="Join the waitlist" variant="tonal" icon="open_in_new" onClick={() => navigate(phoneWaitlistUrl())} />
        </div>
        {!own ? (
          <button type="button" className={styles.ownLink} onClick={() => setOwn(true)}>
            Connect my own server
          </button>
        ) : (
          <SettingsGroup id="cloud-own" title="Connect my own server" description="Sign in to your own sickofpdfs server. Nothing is sent until you tap Connect.">
            <div className={styles.connect}>
              <TextField
                label="Server address"
                value={server}
                onChange={setServer}
                invalid={problem !== null}
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onEnter={() => void connect(server)}
              />
              {problem !== null && (
                <p className={styles.problem} role="alert">
                  {problem}
                </p>
              )}
              <div className={styles.buttons}>
                <TextButton label="Cancel" onClick={() => setOwn(false)} disabled={busy} />
                <TextButton label={busy ? 'Signing in…' : 'Connect'} variant="tonal" onClick={() => void connect(server)} disabled={busy || server.trim() === ''} />
              </div>
            </div>
          </SettingsGroup>
        )}
      </SettingsSection>
    );
  }

  const host = new URL(cloud.server).host;
  const line = statusLine(sync, now);
  return (
    <SettingsSection id="cloud" title="Cloud" intro="Your library and notes stay the same on your phone, in Chrome and on the web.">
      <SettingsGroup id="cloud-server" title="Your server">
        <SettingsRow label="Connected to" value={host} />
        {cloud.signedIn ? (
          <>
            <div className={styles.status} role="status">
              <span className={styles.statusLabel}>Sync</span>
              <span className={line.problem ? styles.statusProblem : styles.statusText}>{line.text}</span>
            </div>
            <div className={styles.buttons}>
              <TextButton label="Sign out" onClick={() => void signOut(false)} disabled={busy} />
              <TextButton label="Sync now" icon="refresh" variant="tonal" onClick={syncNow} disabled={busy || sync?.state === 'syncing'} />
            </div>
          </>
        ) : (
          <>
            <div className={styles.status} role="status">
              <span className={styles.statusLabel}>Sync</span>
              <span className={styles.statusProblem}>You are signed out, so sync has stopped. Your changes are safe on this phone.</span>
            </div>
            {problem !== null && (
              <p className={styles.problem} role="alert">
                {problem}
              </p>
            )}
            <div className={styles.buttons}>
              <TextButton label="Disconnect" onClick={() => void signOut(true)} disabled={busy} />
              <TextButton label={busy ? 'Signing in…' : 'Sign in again'} variant="tonal" onClick={() => void connect(cloud.server ?? OWNER_SERVER)} disabled={busy} />
            </div>
          </>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
