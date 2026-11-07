// Settings → Download with notes (slice 8.3): the name on the owner's notes in a downloaded copy (the synced setting
// `export.authorName`, viewer/export/author-name.ts). The viewer asks for it once, on the first "Download with notes".
import { TextField } from '@sop/ui';
import { useEffect, useState } from 'react';
import { useLibrary } from '../../../app/context';
import { AUTHOR_NAME_KEY, AUTHOR_NAME_MAX, cleanAuthorName } from '../../../../viewer/export/author-name';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection';

export function DownloadWithNotesSection() {
  const { data, notify } = useLibrary();
  const [name, setName] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  useEffect(() => {
    data.getSetting(AUTHOR_NAME_KEY).then(
      (v) => {
        const now = typeof v === 'string' ? cleanAuthorName(v) : '';
        setName(now);
        setSaved(now);
      },
      () => setName(''),
    );
  }, [data]);

  const keep = () => {
    if (name === null) return;
    const next = cleanAuthorName(name);
    setName(next);
    if (next === saved) return;
    data.setSetting(AUTHOR_NAME_KEY, next).then(
      () => {
        setSaved(next);
        notify({ text: next === '' ? 'Your notes will have no name.' : `Your notes will say “${next}”.` });
      },
      () => notify({ text: 'Couldn’t change it. Try again.' }),
    );
  };

  return (
    <SettingsSection id="downloads" title="Download with notes" intro="In the viewer, File → Download with notes gives you a copy of the PDF with your marks and comments in it. Your original file never changes.">
      <SettingsGroup id="downloads-name" title="Your notes in other PDF apps">
        <SettingsRow
          label="Your name on the notes"
          labelId="downloads-name-label"
          value="Acrobat, Foxit and other PDF apps show it beside each of your notes. Claude’s notes say “Claude”. Leave it empty for no name."
          actions={
            <TextField
              label="Your name on the notes"
              value={name ?? ''}
              disabled={name === null}
              width={200}
              onChange={(v) => setName(v.slice(0, AUTHOR_NAME_MAX))}
              onEnter={keep}
              onBlur={keep}
            />
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
