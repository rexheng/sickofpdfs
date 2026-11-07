// Settings → Reading → Scanned PDFs (Phase 7.5): the switches for reading the text of scans (contracts §9's settings keys,
// library settings rows, both on until the owner turns them off):
// - `ocr.enabled`: "Read text on scanned PDFs". Off stops every reading at once, in the tabs and in the background
//   (viewer/ocr/wire.ts and ocr/bg-worker.ts follow it), and nothing is read until it is on again.
// - `ocr.unsavedInMemory` (D7.1): also read scans that are not saved, in their tab only; nothing of them is kept.
// The languages are the engine's (ocr/engine/models.ts): one pass reads them all, so there is no choice to make.
import { Switch } from '@sop/ui/library';
import { useEffect, useState } from 'react';
import { OCR_LANGS } from '../../ocr/engine/models';
import { useLibrary } from '../app/context';
import { SettingsGroup, SettingsRow } from '../pages/Settings/SettingsSection';

export const OCR_ENABLED_KEY = 'ocr.enabled';
export const OCR_UNSAVED_KEY = 'ocr.unsavedInMemory';

/** "English, French and German", English first, as the engine lists them. */
export function languageNames(codes: readonly string[]): string {
  let names: string[];
  try {
    const display = new Intl.DisplayNames(['en'], { type: 'language' });
    names = codes.map((c) => display.of(c) ?? c);
  } catch {
    names = [...codes];
  }
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/** A library setting that is on unless the owner turned it off. */
function useOnSetting(key: string): [boolean | null, (next: boolean) => void] {
  const { data, notify } = useLibrary();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    data.getSetting(key).then(
      (v) => live && setOn(v !== false),
      () => live && setOn(true),
    );
    return () => {
      live = false;
    };
  }, [data, key]);
  const change = (next: boolean) => {
    setOn(next);
    data.setSetting(key, next).catch(() => {
      setOn(!next);
      notify({ text: 'Couldn’t change it. Try again.' });
    });
  };
  return [on, change];
}

export function ScanReadingGroup() {
  const [enabled, setEnabled] = useOnSetting(OCR_ENABLED_KEY);
  const [unsaved, setUnsaved] = useOnSetting(OCR_UNSAVED_KEY);
  const off = enabled === false;
  return (
    <SettingsGroup id="reading-scans" title="Scanned PDFs">
      <SettingsRow
        label="Read text on scanned PDFs"
        labelId="reading-ocr"
        value={
          <>
            Turns the pictures of a scan’s pages into text you can select, mark and search. Each page takes a few seconds, and the
            page you’re on goes first.
            <br />
            Runs on this computer only. Nothing is sent anywhere.
          </>
        }
        actions={<Switch checked={enabled === true} disabled={enabled === null} aria-labelledby="reading-ocr" onChange={setEnabled} />}
      />
      <SettingsRow
        inset
        muted={off}
        label="Also read scans that aren’t saved"
        labelId="reading-ocr-unsaved"
        value="Their text is kept in that tab only, and is gone when you close it. Nothing is saved."
        actions={<Switch checked={unsaved === true && !off} disabled={unsaved === null || off} aria-labelledby="reading-ocr-unsaved" onChange={setUnsaved} />}
      />
      <SettingsRow inset muted={off} label="Languages" value={`${languageNames(OCR_LANGS)} are ready. All of them are read together, so there’s nothing to choose.`} />
    </SettingsGroup>
  );
}
