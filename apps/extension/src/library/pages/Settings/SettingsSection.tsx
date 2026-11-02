// The parts every Settings section is made of, in the Backup section's look (S13): a 22/28 heading and a line of plain
// words, then groups of rows. Each row has its words on the left (a label in 500 and a line in the secondary colour) and
// its controls on the right, with Drive's 1 px #c4c7c5 dividers. Phase 4's Claude section uses the same parts.
import type { ReactNode } from 'react';
import styles from './SettingsSection.module.css';

export interface SettingsSectionProps {
  /** The section's registry id: its heading's id is `<id>-title`. */
  id: string;
  title: string;
  /** One or two sentences under the heading. */
  intro?: ReactNode;
  children: ReactNode;
}

export function SettingsSection({ id, title, intro, children }: SettingsSectionProps) {
  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={styles.title}>
        {title}
      </h2>
      {intro !== undefined && <p className={styles.intro}>{intro}</p>}
      {children}
    </section>
  );
}

/** A group of rows under a 16/24 sub-heading, with a line about it. */
export function SettingsGroup({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.group} role="group" aria-labelledby={`${id}-head`}>
      <h3 id={`${id}-head`} className={styles.groupTitle}>
        {title}
      </h3>
      {description !== undefined && <p className={styles.groupText}>{description}</p>}
      <div className={styles.rows}>{children}</div>
    </div>
  );
}

export interface SettingsRowProps {
  /** At the start: an icon (a site or a folder). */
  icon?: ReactNode;
  label: ReactNode;
  /** Its id, for a switch named by the row's words. */
  labelId?: string;
  /** Lines under the label, in the secondary colour. */
  value?: ReactNode;
  /** Said in the error colour: what is wrong with this row. */
  problem?: ReactNode;
  /** Buttons or a switch, at the end. */
  actions?: ReactNode;
  /** A row that is part of another (it follows a switch it depends on): indented. */
  inset?: boolean;
  /** Greyed out, as a row whose switch above is off. */
  muted?: boolean;
}

export function SettingsRow({ icon, label, labelId, value, problem, actions, inset = false, muted = false }: SettingsRowProps) {
  return (
    <div className={[styles.row, inset ? styles.inset : '', muted ? styles.muted : ''].filter(Boolean).join(' ')}>
      {icon !== undefined && <span className={styles.icon}>{icon}</span>}
      <div className={styles.text}>
        <span id={labelId} className={styles.label}>
          {label}
        </span>
        {value !== undefined && <span className={styles.value}>{value}</span>}
        {problem !== undefined && problem !== null && <span className={`${styles.value} ${styles.attention}`}>{problem}</span>}
      </div>
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}

/** A quiet note in a section (a feature that arrives later), on Drive's tonal surface with an icon. */
export function SettingsNote({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className={styles.note}>
      {icon}
      <span>{children}</span>
    </p>
  );
}
