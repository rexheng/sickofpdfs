// The Settings page's sections, in order (plan S14; contracts §5 "SETTINGS_SECTIONS registry"). The page draws each one, lists
// it in its section list and gives it the address `library.html#/settings/<id>`. A later phase adds a section with a file of its
// own and one line here (Phase 4: Claude, its key and model).
import type { IconName } from '@sop/ui';
import type { ComponentType } from 'react';
import { LibraryRulesSection } from '../pages/Settings/sections/LibraryRules';
import { OnlineLookupsSection } from '../pages/Settings/sections/OnlineLookups';
import { ReadingSection } from '../pages/Settings/sections/Reading';
import { ShortcutsSection } from '../pages/Settings/sections/Shortcuts';
import { BackupSection } from './BackupSection';
import { RestoreSection } from './RestoreSection';

export interface SettingsSectionDef {
  /** Lower-case letters: the address `#/settings/<id>`. */
  id: string;
  /** The section list's label (the section draws its own heading, with the same words). */
  label: string;
  icon: IconName;
  /** The section, heading included: SettingsSection and its rows (pages/Settings/SettingsSection.tsx). */
  Component: ComponentType;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'rules', label: 'Library rules', icon: 'rule', Component: LibraryRulesSection },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', Component: ShortcutsSection },
  { id: 'reading', label: 'Reading', icon: 'menu_book', Component: ReadingSection },
  { id: 'lookups', label: 'Online lookups', icon: 'public', Component: OnlineLookupsSection },
  { id: 'backup', label: 'Backup', icon: 'backup', Component: BackupSection },
  { id: 'restore', label: 'Restore', icon: 'settings_backup_restore', Component: RestoreSection },
];
