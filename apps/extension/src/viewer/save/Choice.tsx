// A check box or a radio choice for the save decision's dialogs, drawn as GM3 does it with the Material Symbols glyphs (a
// 20 px box or circle in the primary colour when on), over the real input, which keeps the keyboard and screen readers.
import { Icon } from '@sop/ui';
import styles from './SaveDialogs.module.css';

export interface ChoiceProps {
  type: 'checkbox' | 'radio';
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The radio group's name. */
  name?: string;
}

export function Choice({ type, label, checked, onChange, name }: ChoiceProps) {
  const glyph = type === 'checkbox' ? (checked ? 'check_box' : 'check_box_outline_blank') : checked ? 'radio_button_checked' : 'radio_button_unchecked';
  return (
    <label className={styles.check}>
      <input className={styles.input} type={type} name={name} checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span className={checked ? styles.boxOn : styles.box}>
        <Icon name={glyph} size={20} filled={checked} />
      </span>
      <span>{label}</span>
    </label>
  );
}
