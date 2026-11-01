import { Dialog, DropdownMenu, TextField } from '@sop/ui';
import { NewButton } from '@sop/ui/library';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { UploadOutcome } from '../data/types';
import { linkToOpen, openPickedPdf } from './open-file';
import styles from './Shell.module.css';

export interface NewMenuHandle {
  /** Opens the file picker of "Open file". */
  pickFile(): void;
}

export interface NewMenuProps {
  onNotify(this: void, text: string): void;
  /** Saves one picked file into the library (Upload PDF); null while the library is not open. */
  onUpload: ((file: File) => Promise<UploadOutcome>) | null;
}

const quoted = (name: string) => `“${name}”`;

/**
 * "+ New" with Upload PDF, Open file and Paste link (spec "Library and knowledge base"; ruling R76). Upload PDF saves one
 * or more PDFs into the library, as the owner's choice, without opening them. Open file opens one in the viewer, where
 * the usual save decision applies. Paste link opens the link in a new tab, where the takeover shows it in the viewer.
 */
export const NewMenu = forwardRef<NewMenuHandle, NewMenuProps>(function NewMenu({ onNotify, onUpload }, ref) {
  const upload = useRef<HTMLInputElement>(null);
  const single = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  const [link, setLink] = useState('');
  const [invalid, setInvalid] = useState(false);
  useImperativeHandle(ref, () => ({ pickFile: () => single.current?.click() }), []);

  const uploadFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    if (onUpload === null) {
      onNotify('Your library isn’t open yet. Try again in a moment.');
      return;
    }
    onNotify(list.length === 1 ? `Saving ${quoted(list[0].name)} to your library…` : `Saving ${list.length} PDFs to your library…`);
    const problems: string[] = [];
    let saved = 0;
    let already = 0;
    for (const file of list) {
      const result = await onUpload(file).catch((): UploadOutcome => 'failed');
      if (result === 'saved') saved += 1;
      else if (result === 'already-saved') already += 1;
      else if (result === 'not-pdf') problems.push(`${quoted(file.name)} isn’t a PDF.`);
      else if (result === 'needs-password') problems.push(`${quoted(file.name)} has a password. Use Open file to type it.`);
      else problems.push(`Couldn’t save ${quoted(file.name)}. Try again.`);
    }
    const done =
      saved > 0
        ? list.length === 1
          ? `Saved ${quoted(list[0].name)} to your library.`
          : `Saved ${saved} ${saved === 1 ? 'PDF' : 'PDFs'} to your library.`
        : already > 0 && problems.length === 0
          ? list.length === 1
            ? `${quoted(list[0].name)} is already in your library.`
            : 'These PDFs are already in your library.'
          : '';
    onNotify([done, ...problems].filter((t) => t !== '').join(' '));
  };
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
          void uploadFiles(e.currentTarget.files);
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
