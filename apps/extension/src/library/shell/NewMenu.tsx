import { Dialog, DropdownMenu, TextField } from '@sop/ui';
import { NewButton } from '@sop/ui/library';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { linkToOpen, openPickedPdf } from './open-file';
import styles from './Shell.module.css';

export interface NewMenuHandle {
  /** Opens the file picker of "Open file". */
  pickFile(): void;
}

/**
 * "+ New" with Upload PDF, Open file and Paste link (spec "Library and knowledge base"). Upload PDF takes one or more
 * PDFs, Open file one; each opens in the viewer, which saves it if it is a learning PDF. Paste link opens the link in
 * a new tab, where the takeover shows it in the viewer.
 */
export const NewMenu = forwardRef<NewMenuHandle, { onNotify(this: void, text: string): void }>(function NewMenu({ onNotify }, ref) {
  const upload = useRef<HTMLInputElement>(null);
  const single = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  const [link, setLink] = useState('');
  const [invalid, setInvalid] = useState(false);
  useImperativeHandle(ref, () => ({ pickFile: () => single.current?.click() }), []);

  const openFiles = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const result = await openPickedPdf(file).catch(() => 'failed' as const);
      if (result === 'not-pdf') onNotify(`“${file.name}” isn’t a PDF.`);
      else if (result === 'failed') onNotify(`Couldn’t open “${file.name}”. Try again.`);
    }
  };
  const closePaste = () => {
    setPasting(false);
    setLink('');
    setInvalid(false);
  };
  const openLink = () => {
    const url = linkToOpen(link);
    if (url === null) {
      setInvalid(true);
      return;
    }
    closePaste();
    void chrome.tabs.create({ url }).catch(() => onNotify('Couldn’t open that link. Try again.'));
  };

  return (
    <>
      <DropdownMenu
        trigger={<NewButton />}
        items={[
          { kind: 'item', id: 'upload', label: 'Upload PDF', icon: 'upload_file', onSelect: () => upload.current?.click() },
          { kind: 'item', id: 'open', label: 'Open file', icon: 'file_open', onSelect: () => single.current?.click() },
          { kind: 'separator' },
          // After the menu has closed and given the focus back, so the dialog's field keeps it.
          { kind: 'item', id: 'paste', label: 'Paste link', icon: 'add_link', onSelect: () => setTimeout(() => setPasting(true), 0) },
        ]}
      />
      <input
        ref={upload}
        className={styles.picker}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          void openFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      <input
        ref={single}
        className={styles.picker}
        type="file"
        accept="application/pdf,.pdf"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          void openFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      <Dialog
        open={pasting}
        title="Open a link"
        onOpenChange={(open) => !open && closePaste()}
        actions={[
          { label: 'Cancel', onClick: closePaste },
          { label: 'Open', primary: true, onClick: openLink },
        ]}
      >
        <p className={styles.dialogText}>Paste the link to a PDF. It opens in a new tab.</p>
        <TextField
          label="Link to a PDF"
          placeholder="https://"
          value={link}
          onChange={(v) => {
            setLink(v);
            setInvalid(false);
          }}
          onEnter={openLink}
          invalid={invalid}
          autoFocus
          aria-describedby={invalid ? 'paste-link-error' : undefined}
        />
        {invalid && (
          <p id="paste-link-error" className={styles.fieldError}>
            That isn’t a link. A link starts with https://
          </p>
        )}
      </Dialog>
    </>
  );
});
