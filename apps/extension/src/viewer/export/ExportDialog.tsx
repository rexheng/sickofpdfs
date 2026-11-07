// "Download with notes" asks something only when it must (slice 8.3): the owner's name, the first time (Acrobat and Foxit
// show it beside each note), and a warning before a signed PDF gets notes (its signature then shows as changed). Every
// other time the copy downloads at once, with a snackbar. Drive's small dark dialog, plain words.
import { Dialog, TextField } from '@sop/ui';
import { useId, useState } from 'react';
import saveStyles from '../save/SaveDialogs.module.css';
import styles from '../ui/cards.module.css';
import { AUTHOR_NAME_MAX, cleanAuthorName } from './author-name';

export type ExportAsk = { kind: 'name' } | { kind: 'signed'; signatures: number };

/** The answer: the name typed (blank is allowed: the notes then carry no name), `true` to go on, or null for Cancel. */
export type ExportAnswer = { name: string } | true | null;

export interface ExportDialogProps {
  ask: ExportAsk;
  /** Called once: Cancel, Escape and a click outside give null. */
  onAnswer(this: void, answer: ExportAnswer): void;
}

export function ExportDialog({ ask, onAnswer }: ExportDialogProps) {
  return ask.kind === 'name' ? <NameStep onAnswer={onAnswer} /> : <SignedStep signatures={ask.signatures} onAnswer={onAnswer} />;
}

/** The first "Download with notes": the name that goes on the owner's notes. */
function NameStep({ onAnswer }: Pick<ExportDialogProps, 'onAnswer'>) {
  const [name, setName] = useState('');
  const id = useId();
  const hint = useId();
  const go = () => onAnswer({ name: cleanAuthorName(name) });
  return (
    <Dialog
      open
      title="Your name on the notes"
      actions={[
        { label: 'Cancel', onClick: () => onAnswer(null) },
        { label: 'Download', primary: true, onClick: go },
      ]}
      onOpenChange={(open) => !open && onAnswer(null)}
    >
      <p className={styles.body}>Other PDF apps, like Acrobat and Foxit, show this name beside each of your notes. Claude’s notes say “Claude”.</p>
      <div className={styles.field}>
        <label htmlFor={id} className={styles.fieldLabel}>
          Your name
        </label>
        <TextField id={id} label="Your name" value={name} onChange={(v) => setName(v.slice(0, AUTHOR_NAME_MAX))} onEnter={go} autoFocus aria-describedby={hint} className={styles.fullWidth} />
      </div>
      <p id={hint} className={saveStyles.small}>
        You can leave it empty. To change it later, open Settings, then Download with notes.
      </p>
    </Dialog>
  );
}

/** A signed PDF: notes change what was signed, so readers will say the signature changed. The original stays as it is. */
function SignedStep({ signatures, onAnswer }: { signatures: number } & Pick<ExportDialogProps, 'onAnswer'>) {
  return (
    <Dialog
      open
      focusPrimary
      title="This PDF is signed"
      actions={[
        { label: 'Cancel', onClick: () => onAnswer(null) },
        { label: 'Download with notes', primary: true, onClick: () => onAnswer(true) },
      ]}
      onOpenChange={(open) => !open && onAnswer(null)}
    >
      <p className={styles.body}>
        It has {signatures === 1 ? 'a digital signature' : `${signatures} digital signatures`}. In the copy with your notes, other PDF apps will say the signature
        has changed.
      </p>
      <p className={styles.body}>Your original file stays as it is, with its signature.</p>
    </Dialog>
  );
}
