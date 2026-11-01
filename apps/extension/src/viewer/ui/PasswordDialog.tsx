import { Dialog, TextField } from '@sop/ui';
import { useEffect, useId, useState } from 'react';
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
 * Chrome's viewer. The dialog is named by a title attribute, so the field alone is labelled "Password". The field has
 * a visible "Password" label and runs the full width of the dialog; the line under it is kept for the error from the
 * start, so the dialog does not move when "Incorrect password" appears.
 */
export function PasswordDialog({ retry, attempt, onSubmit }: PasswordDialogProps) {
  const [value, setValue] = useState('');
  const [empty, setEmpty] = useState(false);
  const id = useId();
  useEffect(() => {
    setValue('');
    setEmpty(false);
  }, [attempt]);
  const submit = () => {
    if (value === '') setEmpty(true);
    else onSubmit(value);
  };
  const error = empty ? 'Type the password first.' : retry ? 'Incorrect password. Try again.' : null;
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
        <label htmlFor={id} className={styles.fieldLabel}>
          Password
        </label>
        <TextField
          id={id}
          type="password"
          label="Password"
          value={value}
          onChange={(v) => {
            setValue(v);
            setEmpty(false);
          }}
          onEnter={submit}
          autoFocus
          invalid={error !== null}
          className={styles.fullWidth}
        />
      </div>
      <p role="alert" className={styles.error}>
        {error}
      </p>
    </Dialog>
  );
}
