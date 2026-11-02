// Settings → Online lookups (plan S14 hosts the switch; S12 does the lookups). The synced setting `lookups.online`, off until
// the owner turns it on (D10: no network traffic except what the owner turns on).
import { Icon } from '@sop/ui';
import { Switch } from '@sop/ui/library';
import { useEffect, useState } from 'react';
import { useLibrary } from '../../../app/context';
import { SettingsGroup, SettingsNote, SettingsRow, SettingsSection } from '../SettingsSection';

export const LOOKUPS_KEY = 'lookups.online';

export function OnlineLookupsSection() {
  const { data, notify } = useLibrary();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    data.getSetting(LOOKUPS_KEY).then(
      (v) => setOn(v === true),
      () => setOn(false),
    );
  }, [data]);

  const change = (next: boolean) => {
    setOn(next);
    data.setSetting(LOOKUPS_KEY, next).catch(() => {
      setOn(!next);
      notify({ text: 'Couldn’t change it. Try again.' });
    });
  };

  return (
    <SettingsSection
      id="lookups"
      title="Online lookups"
      intro="sickofpdfs works without the internet. This is the one thing that can go online, and only if you turn it on."
    >
      <SettingsNote icon={<Icon name="info" size={20} />}>The lookups arrive in a later test build. Until then nothing is sent, even with this on.</SettingsNote>
      <SettingsGroup id="lookups-group" title="Fill in missing details">
        <SettingsRow
          label="Look up titles and authors online"
          labelId="lookups-switch"
          value="For a saved PDF with a DOI or arXiv number, asks arXiv or Crossref for its title, authors and year when they are missing. Only that number is sent. Nothing is sent for PDFs that aren’t saved."
          actions={<Switch checked={on === true} disabled={on === null} aria-labelledby="lookups-switch" onChange={change} />}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
