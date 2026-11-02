// "Change" in Settings → Shortcuts: a dialog that listens for the new key, checks it (shortcuts/overrides.ts), and says in
// plain words why it cannot be used, or what to be careful of, before Save. Tab and Esc keep their jobs: Tab moves on and
// Esc closes, so the dialog can always be left by keyboard.
import { Dialog, Icon } from '@sop/ui';
import { useEffect, useId, useState } from 'react';
import { checkCombo, type ComboCheck, type CommandKeys, comboFromEvent } from '../../../../shortcuts/overrides';
import type { KeyCombo } from '../../../../viewer/shortcuts';
import styles from './sections.module.css';
import { Keys, type ShortcutCommand } from './keys';

export interface KeyDialogProps {
  /** The command whose key is being changed; null: the dialog is closed. */
  command: ShortcutCommand | null;
  /** Its keys now. */
  keys: readonly KeyCombo[];
  /** Every command with its keys now, for the conflict check. */
  commands: readonly CommandKeys[];
  onClose(this: void): void;
  /** The new keys: one key, or none ("No key"). */
  onSave(this: void, keys: KeyCombo[]): void;
}

export function KeyDialog({ command, keys, commands, onClose, onSave }: KeyDialogProps) {
  const [pressed, setPressed] = useState<KeyCombo | null>(null);
  const [check, setCheck] = useState<ComboCheck | null>(null);
  const verdictId = useId();

  useEffect(() => {
    setPressed(null);
    setCheck(null);
  }, [command]);

  const usable = pressed !== null && check !== null && (check.kind === 'ok' || check.kind === 'careful');

  return (
    <Dialog
      open={command !== null}
      title={command === null ? '' : `Key for ${command.label}`}
      onOpenChange={(open) => !open && onClose()}
      actions={[
        { label: 'Cancel', onClick: onClose },
        { label: 'No key', onClick: () => onSave([]) },
        { label: 'Save', primary: true, disabled: !usable, onClick: () => usable && onSave([pressed]) },
      ]}
    >
      <div className={styles.capture}>
        <p className={styles.verdict}>Press the keys you want to use. Esc closes this without a change.</p>
        <div
          className={styles.captureBox}
          tabIndex={0}
          role="textbox"
          aria-label="New key"
          aria-describedby={verdictId}
          aria-readonly="true"
          onKeyDown={(e) => {
            const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
            if (plain && (e.key === 'Tab' || e.key === 'Escape')) return;
            e.preventDefault();
            e.stopPropagation();
            const combo = comboFromEvent(e.nativeEvent);
            if (combo === null || command === null) return;
            setPressed(combo);
            setCheck(checkCombo(combo, command.id, commands));
          }}
        >
          <Keys keys={pressed === null ? keys : [pressed]} />
        </div>
        <Verdict id={verdictId} pressed={pressed} check={check} />
      </div>
    </Dialog>
  );
}

function Verdict({ id, pressed, check }: { id: string; pressed: KeyCombo | null; check: ComboCheck | null }) {
  if (pressed === null || check === null) {
    return (
      <p id={id} className={styles.verdict} aria-live="polite">
        This is the key now. Press a new one to change it.
      </p>
    );
  }
  if (check.kind === 'refused' || check.kind === 'taken') {
    return (
      <p id={id} className={`${styles.verdict} ${styles.verdictBad}`} aria-live="polite">
        <Icon name="error" size={20} />
        <span>{check.message}</span>
      </p>
    );
  }
  if (check.kind === 'careful') {
    return (
      <p id={id} className={styles.verdict} aria-live="polite">
        <Icon name="warning" size={20} />
        <span>{check.message} You can still use it.</span>
      </p>
    );
  }
  return (
    <p id={id} className={styles.verdict} aria-live="polite">
      <Icon name="check" size={20} />
      <span>That key is free. Choose Save to use it.</span>
    </p>
  );
}
