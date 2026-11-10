// Settings → Shortcuts (plan S14; spec "All are rebindable in Settings"). Every viewer command, grouped as the shortcut sheet
// groups them, with its key and "Change". The key dialog checks the new key before it can be saved: never one Chrome keeps or
// one the viewer reads with, never one another command has (the conflict check), and a warning for Ctrl+Alt+letter.
//
// The keys are the synced setting `shortcuts.overrides`; the viewer reads a copy of it (shortcuts/overrides.ts), which this
// section refreshes each time it opens. A PDF opened after a change uses the new key.
import { Icon, TextButton } from '@sop/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type CommandKeys,
  cleanOverrides,
  readOverrides,
  SHORTCUT_OVERRIDES_KEY,
  type ShortcutOverrides,
  shownCombo,
  withOverride,
  writeOverridesMirror,
} from '../../../../shortcuts/overrides';
import { SPECS } from '../../../../viewer/commands';
import type { KeyCombo } from '../../../../viewer/shortcuts';
import { useLibrary } from '../../../app/context';
import { SettingsNote, SettingsSection } from '../SettingsSection';
import { KeyDialog } from './KeyDialog';
import { Keys, type ShortcutCommand } from './keys';
import styles from './sections.module.css';

/** The groups of the shortcut sheet (ShortcutsDialog.tsx), in its order. */
const GROUPS: { id: string; title: string; prefixes: string[] }[] = [
  { id: 'file', title: 'File', prefixes: ['file.'] },
  { id: 'view', title: 'View', prefixes: ['view.'] },
  { id: 'tools', title: 'Tools', prefixes: ['tools.'] },
  { id: 'marks', title: 'Marks and notes', prefixes: ['marks.', 'notes.', 'figures.'] },
  { id: 'edit', title: 'Edit', prefixes: ['edit.'] },
  { id: 'help', title: 'Help', prefixes: ['help.'] },
];

const COMMANDS: readonly ShortcutCommand[] = SPECS.map(([id, spec]) => ({ id, label: spec.label, defaults: spec.keys }));
const KNOWN = new Set(COMMANDS.map((c) => c.id));

export function ShortcutsSection() {
  const { data, notify } = useLibrary();
  const [overrides, setOverrides] = useState<ShortcutOverrides>(readOverrides);
  const [editing, setEditing] = useState<ShortcutCommand | null>(null);

  // The setting is the record; the viewer's copy follows it (a restore or a sync may have changed it).
  useEffect(() => {
    data.getSetting(SHORTCUT_OVERRIDES_KEY).then(
      (value) => {
        const clean = cleanOverrides(value, KNOWN);
        setOverrides(clean);
        writeOverridesMirror(clean);
      },
      () => {}, // the copy stands until the library can be read
    );
  }, [data]);

  const current = useMemo<CommandKeys[]>(
    () => COMMANDS.map((c) => ({ id: c.id, label: c.label, keys: overrides[c.id] ?? c.defaults })),
    [overrides],
  );

  const save = useCallback(
    (command: ShortcutCommand, keys: readonly KeyCombo[] | null, said: string) => {
      const next = withOverride(overrides, command.id, keys, command.defaults);
      data.setSetting(SHORTCUT_OVERRIDES_KEY, next).then(
        () => {
          setOverrides(next);
          writeOverridesMirror(next);
          notify({ text: said });
        },
        () => notify({ text: 'Couldn’t save the key. Try again.' }),
      );
    },
    [data, notify, overrides],
  );

  return (
    <SettingsSection
      id="shortcuts"
      title="Shortcuts"
      intro="The keys that work in the viewer. Change any of them to one that suits you. A PDF you open after a change uses the new key."
    >
      {Object.keys(overrides).length > 0 && (
        <SettingsNote icon={<Icon name="info" size={20} />}>
          You changed {Object.keys(overrides).length === 1 ? '1 key' : `${Object.keys(overrides).length} keys`}. Reset puts a key back the way it was.
        </SettingsNote>
      )}
      <div className={styles.sheet}>
        {GROUPS.map((g) => {
          const rows = COMMANDS.filter((c) => g.prefixes.some((p) => c.id.startsWith(p)));
          if (rows.length === 0) return null;
          return (
            <div key={g.id} className={styles.keyGroup} role="group" aria-labelledby={`shortcuts-${g.id}-head`}>
              <h3 id={`shortcuts-${g.id}-head`} className={styles.keyGroupTitle}>
                {g.title}
              </h3>
              <div className={styles.keyRows}>
                {rows.map((c) => {
                  const changed = overrides[c.id] !== undefined;
                  return (
                    <div key={c.id} className={styles.keyRow}>
                      <span className={styles.keyLabel}>
                        {c.label}
                        {changed && <span className={styles.changed}> · changed</span>}
                      </span>
                      <Keys keys={overrides[c.id] ?? c.defaults} />
                      <span className={styles.keyActions}>
                        {changed && (
                          <TextButton className={styles.keyBtn} label="Reset" aria-label={`Reset the key for ${c.label}`} onClick={() => save(c, null, `${c.label} has its own key again.`)} />
                        )}
                        <TextButton className={styles.keyBtn} label="Change" aria-label={`Change the key for ${c.label}`} onClick={() => setEditing(c)} />
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <KeyDialog
        command={editing}
        keys={editing === null ? [] : (overrides[editing.id] ?? editing.defaults)}
        commands={current}
        onClose={() => setEditing(null)}
        onSave={(keys) => {
          const c = editing;
          setEditing(null);
          if (c !== null) save(c, keys, keys.length === 0 ? `${c.label} has no key now.` : `${c.label} is now ${shownCombo(keys[0] ?? '')}.`);
        }}
      />
    </SettingsSection>
  );
}
