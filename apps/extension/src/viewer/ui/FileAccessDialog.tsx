import { Dialog } from '@sop/ui';
import styles from './cards.module.css';
import { useFilePicker } from './FilePicker';

export interface FileAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Open extension settings": Chrome's page for this extension, where file access is switched on. */
  onOpenSettings: () => void;
  /** "Choose file": the person picked the PDF themselves. */
  onChooseFile: (file: File) => void;
}

/** A file:// PDF could not be read because "Allow access to file URLs" is off. */
export function FileAccessDialog({ open, onOpenChange, onOpenSettings, onChooseFile }: FileAccessDialogProps) {
  const picker = useFilePicker(onChooseFile);
  return (
    <Dialog
      open={open}
      title="Allow access to file URLs"
      onOpenChange={onOpenChange}
      actions={[
        { label: 'Open extension settings', onClick: onOpenSettings },
        { label: 'Choose file', primary: true, onClick: picker.open },
      ]}
    >
      <p className={styles.body}>Chrome needs your OK before this viewer can open PDFs saved on your computer.</p>
      <p className={styles.body}>In the extension settings, turn on “Allow access to file URLs”. Or choose the file yourself.</p>
      {picker.input}
    </Dialog>
  );
}
