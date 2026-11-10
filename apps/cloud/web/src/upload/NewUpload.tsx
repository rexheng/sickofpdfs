// "+ New" in the web library (CL15): Upload PDF, from this computer or phone. On a computer it is Drive's "+ New" button with its
// menu; on a phone, Drive's round "+" button above the bottom bar. A PDF dropped anywhere on the library is uploaded too.
import { DropdownMenu, Icon } from '@sop/ui';
import { NewButton } from '@sop/ui/library';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { uploads } from './uploads';
import styles from './NewUpload.module.css';

export interface UploadPicker {
  pick(): void;
}

/** The hidden file picker, shared by the button, the phone's "+" and "+ New" → Upload PDF. */
export const UploadInput = forwardRef<UploadPicker>(function UploadInput(_, ref) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ pick: () => input.current?.click() }), []);
  return (
    <input
      ref={input}
      className={styles.picker}
      type="file"
      accept="application/pdf,.pdf"
      multiple
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        uploads.add(Array.from(e.currentTarget.files ?? []));
        e.currentTarget.value = '';
      }}
    />
  );
});

/** Drive's "+ New" on a computer: its menu has Upload PDF. */
export function WebNewButton({ onPick, disabled }: { onPick: () => void; disabled: boolean }) {
  return (
    <DropdownMenu
      trigger={<NewButton disabled={disabled} />}
      items={[{ kind: 'item', id: 'upload', label: 'Upload PDF', icon: 'upload_file', onSelect: onPick }]}
    />
  );
}

/** Drive's round "+" on a phone, above the bottom bar. */
export function UploadFab({ onPick, disabled }: { onPick: () => void; disabled: boolean }) {
  return (
    <button type="button" className={styles.fab} aria-label="Upload PDF" onClick={onPick} disabled={disabled}>
      <Icon name="add" size={24} />
    </button>
  );
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** While PDFs are dragged over the page: a frame that says where they go. Dropping them uploads them. */
export function DropToUpload({ enabled }: { enabled: boolean }) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      uploads.add(Array.from(e.dataTransfer?.files ?? []));
    };
    addEventListener('dragenter', enter);
    addEventListener('dragleave', leave);
    addEventListener('dragover', overFn);
    addEventListener('drop', drop);
    return () => {
      removeEventListener('dragenter', enter);
      removeEventListener('dragleave', leave);
      removeEventListener('dragover', overFn);
      removeEventListener('drop', drop);
    };
  }, [enabled]);
  if (!over) return null;
  return (
    <div className={styles.drop} aria-hidden="true">
      <p className={styles.dropText}>
        <Icon name="upload_file" size={24} />
        Drop PDFs to add them to your library
      </p>
    </div>
  );
}
