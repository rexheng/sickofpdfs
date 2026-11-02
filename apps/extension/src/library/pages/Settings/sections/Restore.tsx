// Settings → Restore: the place S17's "Restore from backup" takes. Until it lands, it says plainly what it will do and that the
// backups are safe meanwhile. It has no button, so nothing looks as if it works when it does not.
import { Icon } from '@sop/ui';
import { SettingsNote, SettingsSection } from '../SettingsSection';

export function RestoreSection() {
  return (
    <SettingsSection
      id="restore"
      title="Restore"
      intro="Brings back your library, your PDFs and your notes from a backup folder, on this computer or on a new one. Nothing you have now is deleted."
    >
      <SettingsNote icon={<Icon name="info" size={20} />}>Restoring comes in the next test build. Your backups stay safe in their folder until then.</SettingsNote>
    </SettingsSection>
  );
}
