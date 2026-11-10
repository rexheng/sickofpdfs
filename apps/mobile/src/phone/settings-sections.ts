// The app's version of apps/extension/src/library/settings/sections.ts (swapped in by vite.config.ts): the extension's Settings
// sections, with the phone's own Cloud section (R109) in place of the extension's (or after Claude, while the extension has none),
// and without keyboard Shortcuts, which a phone has no use for.
import { SETTINGS_SECTIONS as EXTENSION_SECTIONS, type SettingsSectionDef } from '@ext/library/settings/sections';
import { CloudSection } from './CloudSection';

export type { SettingsSectionDef } from '@ext/library/settings/sections';

const CLOUD: SettingsSectionDef = { id: 'cloud', label: 'Cloud', icon: 'cloud_done', Component: CloudSection };

function phoneSections(): SettingsSectionDef[] {
  const list = EXTENSION_SECTIONS.filter((s) => s.id !== 'shortcuts').map((s) => (s.id === 'cloud' ? CLOUD : s));
  if (!list.some((s) => s.id === 'cloud')) {
    const after = list.findIndex((s) => s.id === 'claude');
    list.splice(after === -1 ? list.length : after + 1, 0, CLOUD);
  }
  return list;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = phoneSections();
