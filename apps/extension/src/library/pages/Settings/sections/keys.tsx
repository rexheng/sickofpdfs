// The keys of a command as small caps, as the shortcut sheet shows them (Settings → Shortcuts and its key dialog).
import { Fragment } from 'react';
import { shownCombo } from '../../../../shortcuts/overrides';
import type { KeyCombo } from '../../../../viewer/shortcuts';
import styles from './sections.module.css';

export interface ShortcutCommand {
  id: string;
  label: string;
  /** Its own keys, as the viewer ships them. */
  defaults: readonly KeyCombo[];
}

/** The keys as caps, "Ctrl+Plus or Ctrl+Minus"; "No key" when there are none. Two that read the same show once. */
export function Keys({ keys }: { keys: readonly KeyCombo[] }) {
  const shown = [...new Set(keys.map(shownCombo))];
  if (shown.length === 0) return <span className={styles.or}>No key</span>;
  return (
    <span className={styles.keys}>
      {shown.map((k, i) => (
        <Fragment key={k}>
          {i > 0 && <span className={styles.or}>or</span>}
          <kbd className={styles.kbd}>{k}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

