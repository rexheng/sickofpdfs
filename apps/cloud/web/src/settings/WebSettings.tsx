// Settings on the web (plan CL13): what only the cloud knows, in the extension's Settings look (its sections, groups and rows).
//   - Claude: whether Claude (claude.ai, Claude Code) may read the library at all, and whether it may add comments.
//   - Connections: every app signed in to this cloud (Chrome, the phone app, Claude), with Remove.
//   - Devices: the computers, phones and browsers that sync.
//   - Use today: the cloud's daily write budget, so the owner can see how close it is.
//   - This browser: sign out.
// The extension's own settings (shortcuts, the filter, the Claude key, the backup folder) stay in Chrome: they belong to it.
import { Dialog, Icon, type IconName, TextButton } from '@sop/ui';
import { ContentCard, PageTitle, Switch } from '@sop/ui/library';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useLibrary } from '@ext/library/app/context';
import { SettingsGroup, SettingsNote, SettingsRow, SettingsSection } from '@ext/library/pages/Settings/SettingsSection';
import { api } from '../sync/api';
import { SignOutForm } from './SignOut';
import styles from './WebSettings.module.css';

interface Grant {
  id: string;
  clientId: string;
  clientName: string;
  kind: 'extension' | 'android' | 'connector' | 'other';
  scopes: string[];
  createdAt: number;
  expiresAt: number | null;
  device: { id: string; name: string; lastSeenAt: number | null } | null;
}
interface Overview {
  today: { textRows: number; noteRows: number; textLimit: number; notesLimit: number };
  library: { readings: number; bytes: number; pdfsStored: number; notes: number };
  devices: { id: string; name: string; kind: string; createdAt: number; lastSeenAt: number | null; thisBrowser: boolean }[];
}
interface Switches {
  mcpEnabled: boolean;
  claudeCanComment: boolean;
}

const KIND: Record<Grant['kind'], { word: string; icon: IconName }> = {
  extension: { word: 'Chrome extension', icon: 'public' },
  android: { word: 'Android app', icon: 'devices' },
  connector: { word: 'Claude', icon: 'auto_awesome' },
  other: { word: 'App', icon: 'key' },
};
const DEVICE_ICON: Record<string, IconName> = { extension: 'public', android: 'devices', ios: 'devices', web: 'language' };
const DEVICE_WORD: Record<string, string> = { extension: 'Chrome', android: 'Android', ios: 'iPhone', web: 'Browser' };

function when(t: number | null): string {
  if (t === null) return 'Not yet';
  const d = new Date(t);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function useLoad<T>(path: string): { value: T | null; failed: boolean; reload: () => void } {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    setFailed(false);
    api<T>(path).then(setValue, () => setFailed(true));
  }, [path]);
  useEffect(reload, [reload]);
  return { value, failed, reload };
}

export function WebSettingsPage() {
  const { notify } = useLibrary();
  const switches = useLoad<Switches>('/api/server-settings');
  const grants = useLoad<{ grants: Grant[] }>('/api/grants');
  const overview = useLoad<Overview>('/api/web/overview');
  const [shown, setShown] = useState<Switches | null>(null);
  const [removing, setRemoving] = useState<Grant | null>(null);
  useEffect(() => setShown(switches.value), [switches.value]);
  useEffect(() => {
    document.title = 'Settings - sickofpdfs';
  }, []);

  const flip = (field: keyof Switches, on: boolean) => {
    if (shown === null) return;
    const before = shown;
    setShown({ ...shown, [field]: on });
    api('/api/server-settings', { method: 'PUT', json: { [field]: on } }).then(
      () => notify({ text: field === 'mcpEnabled' ? (on ? 'Claude can read your library' : 'Claude can’t read your library now') : on ? 'Claude can add comments' : 'Claude can only read now' }),
      () => {
        setShown(before);
        notify({ text: 'That didn’t change. Try again.' });
      },
    );
  };

  const remove = (g: Grant) => {
    setRemoving(null);
    api(`/api/grants/${encodeURIComponent(g.id)}`, { method: 'DELETE' }).then(
      () => {
        notify({ text: `${g.clientName} is signed out` });
        grants.reload();
        overview.reload();
      },
      () => notify({ text: 'That didn’t work. Try again.' }),
    );
  };

  const unavailable = (what: string, retry: () => void): ReactNode => (
    <SettingsNote icon={<Icon name="cloud_off" size={20} />}>
      {what} couldn’t be loaded. <button type="button" className={styles.inlineButton} onClick={retry}>Try again</button>
    </SettingsNote>
  );

  return (
    <ContentCard header={<PageTitle title="Settings" />}>
      <div className={styles.column}>
        <SettingsSection id="claude" title="Claude" intro="Claude in claude.ai and in Claude Code can search your library and read your notes, once you connect it there.">
          {switches.failed && unavailable('These switches', switches.reload)}
          {shown !== null && (
            <SettingsGroup id="claude-access" title="What Claude may do">
              <SettingsRow
                label="Claude can read your library"
                labelId="sw-mcp"
                value={shown.mcpEnabled ? 'On. Claude sees saved readings, never private ones.' : 'Off. Claude can’t reach your library at all.'}
                actions={<Switch checked={shown.mcpEnabled} aria-labelledby="sw-mcp" onChange={(on) => flip('mcpEnabled', on)} />}
              />
              <SettingsRow
                label="Claude can add comments"
                labelId="sw-comment"
                inset
                muted={!shown.mcpEnabled}
                value="Claude’s comments are marked as Claude’s. It can never change or delete yours."
                actions={<Switch checked={shown.claudeCanComment} disabled={!shown.mcpEnabled} aria-labelledby="sw-comment" onChange={(on) => flip('claudeCanComment', on)} />}
              />
            </SettingsGroup>
          )}
        </SettingsSection>

        <SettingsSection id="connections" title="Connections" intro="Apps that are signed in to your cloud. Remove one to sign it out straight away.">
          {grants.failed && unavailable('Your connections', grants.reload)}
          {grants.value !== null && (
            <SettingsGroup id="connections-list" title={grants.value.grants.length === 1 ? '1 app' : `${grants.value.grants.length} apps`}>
              {grants.value.grants.length === 0 && <SettingsRow label="No apps are signed in" value="Connect Chrome in the extension’s Settings → Cloud." />}
              {grants.value.grants.map((g) => (
                <SettingsRow
                  key={g.id}
                  icon={<Icon name={KIND[g.kind].icon} size={20} />}
                  label={g.device?.name ?? g.clientName}
                  value={`${KIND[g.kind].word} · signed in ${when(g.createdAt)}${g.device ? ` · last synced ${when(g.device.lastSeenAt)}` : ''}${g.kind === 'connector' && !g.scopes.includes('library:comment') ? ' · reading only' : ''}`}
                  actions={<TextButton label="Remove" onClick={() => setRemoving(g)} />}
                />
              ))}
            </SettingsGroup>
          )}
        </SettingsSection>

        <SettingsSection id="devices" title="Devices" intro="Computers, phones and browsers that sync with your cloud.">
          {overview.failed && unavailable('Your devices', overview.reload)}
          {overview.value !== null && (
            <SettingsGroup id="devices-list" title={overview.value.devices.length === 1 ? '1 device' : `${overview.value.devices.length} devices`}>
              {overview.value.devices.map((d) => (
                <SettingsRow
                  key={d.id}
                  icon={<Icon name={DEVICE_ICON[d.kind] ?? 'devices'} size={20} />}
                  label={d.thisBrowser ? `${d.name} (this browser)` : d.name}
                  value={`${DEVICE_WORD[d.kind] ?? 'Device'} · last synced ${when(d.lastSeenAt ?? d.createdAt)}`}
                />
              ))}
            </SettingsGroup>
          )}
        </SettingsSection>

        <SettingsSection id="usage" title="Use today" intro="Your cloud runs on Cloudflare’s free plan, which limits how much it can save each day. The count starts again at midnight UTC.">
          {overview.value !== null && (
            <SettingsGroup id="usage-meters" title="Saved today">
              <Meter label="Notes, marks and changes" used={overview.value.today.textRows + overview.value.today.noteRows} limit={overview.value.today.notesLimit} />
              <Meter label="Page text" used={overview.value.today.textRows + overview.value.today.noteRows} limit={overview.value.today.textLimit} note="Page text waits until tomorrow once this is full. Notes still save." />
              <SettingsRow
                label="Your library"
                value={`${overview.value.library.readings === 1 ? '1 reading' : `${overview.value.library.readings} readings`} · ${overview.value.library.notes === 1 ? '1 note' : `${overview.value.library.notes} notes`} · ${overview.value.library.pdfsStored} PDFs stored (${size(overview.value.library.bytes)})`}
              />
            </SettingsGroup>
          )}
        </SettingsSection>

        <SettingsSection id="browser" title="This browser" intro="The web library keeps nothing on this computer: your library is only in this tab while it is open.">
          <SettingsGroup id="browser-session" title="Signed in with GitHub">
            <SettingsRow
              label="Sign out"
              value="Signs this browser out. Your other devices stay signed in."
              actions={
                <SignOutForm id="sop-sign-out-settings">
                  <TextButton label="Sign out" icon="logout" variant="tonal" type="submit" />
                </SignOutForm>
              }
            />
          </SettingsGroup>
        </SettingsSection>
      </div>
      <Dialog
        open={removing !== null}
        title={`Remove ${removing?.clientName ?? ''}?`}
        onOpenChange={(open) => !open && setRemoving(null)}
        actions={[
          { label: 'Cancel', onClick: () => setRemoving(null) },
          { label: 'Remove', primary: true, onClick: () => removing && remove(removing) },
        ]}
      >
        <p>It is signed out at once. Its notes stay in your library. To use it again, sign in from it.</p>
      </Dialog>
    </ContentCard>
  );
}

function Meter({ label, used, limit, note }: { label: string; used: number; limit: number; note?: string }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <SettingsRow
      label={label}
      value={
        <>
          <span className={styles.meter} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label={label}>
            <span className={styles.meterFill} data-high={share >= 0.9 ? 'true' : undefined} style={{ inlineSize: `${Math.round(share * 100)}%` }} />
          </span>
          <span>
            {used.toLocaleString()} of {limit.toLocaleString()} rows{note !== undefined && share >= 0.9 ? `. ${note}` : ''}
          </span>
        </>
      }
    />
  );
}
