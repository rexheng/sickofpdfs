import { Dialog, TextField } from '@sop/ui';
import { useEffect, useRef, useState } from 'react';

/** The longest title the library keeps. */
const MAX_TITLE = 300;

/** "Rename": a dialog with the title in a field, all of it selected so typing replaces it. Enter saves. */
export function RenameDialog({ title, onSave, onClose }: { title: string | null; onSave(this: void, t: string): void; onClose(this: void): void }) {
  const [value, setValue] = useState(title ?? '');
  const field = useRef<HTMLInputElement>(null);
  const open = title !== null;
  useEffect(() => {
    if (title === null) return;
    setValue(title);
    requestAnimationFrame(() => field.current?.select());
  }, [title]);
  const clean = value.trim().slice(0, MAX_TITLE);
  const save = () => {
    if (clean === '') return;
    onSave(clean);
  };
  return (
    <Dialog
      open={open}
      title="Rename"
      onOpenChange={(next) => !next && onClose()}
      actions={[
        { label: 'Cancel', onClick: onClose },
        { label: 'OK', primary: true, onClick: save },
      ]}
    >
      <TextField ref={field} label="Title" value={value} onChange={setValue} onEnter={save} invalid={clean === ''} maxLength={MAX_TITLE} />
    </Dialog>
  );
}
