import { Dialog, TextField } from '@sop/ui';
import { useEffect, useState } from 'react';
import styles from './cards.module.css';

export interface PasswordDialogProps {
  /** The last password was wrong: show the error and start with an empty field. */
  retry: boolean;
  /** Counts the prompts, so a new prompt clears the field. */
  attempt: number;
  onSubmit: (password: string) => void;
}

/**
 * Asks for the password of an encrypted PDF. It cannot be dismissed (there is nothing behind it to go back to), as in
 * Chrome's viewer. The dialog is named by a title attribute, so the field alone is labelled "Password".
 */
export function PasswordDialog({ retry, attempt, onSubmit }: PasswordDialogProps) {
  const [value, setValue] = useState('');
  useEffect(() => setValue(''), [attempt]);
  const submit = () => {
    if (value !== '') onSubmit(value);
  };
  return (
    <Dialog
      open
      title="This PDF is password protected"
      nameFromTitleAttribute
      actions={[{ label: 'Open', primary: true, onClick: submit }]}
      onOpenChange={() => {}}
    >
      <p className={styles.body}>Enter the password to open it.</p>
      <div className={styles.field}>
        <TextField type="password" label="Password" value={value} onChange={setValue} onEnter={submit} autoFocus invalid={retry} />
      </div>
      {retry && (
        <p role="alert" className={styles.error}>
          Incorrect password. Try again.
        </p>
      )}
    </Dialog>
  );
}
