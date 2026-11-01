import { Dialog } from '@sop/ui';
import { Fragment } from 'react';
import type { ViewerCommandId, ViewerCommands } from '../commands';
import { formatCombo } from './menus';
import styles from './ShortcutsDialog.module.css';

export interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange(this: void, open: boolean): void;
  commands: ViewerCommands;
}

/** The sheet's groups, named as the header's menus. */
const GROUPS: { title: string; prefix: string }[] = [
  { title: 'File', prefix: 'file.' },
  { title: 'View', prefix: 'view.' },
  { title: 'Tools', prefix: 'tools.' },
  { title: 'Help', prefix: 'help.' },
];

const inGroup = (id: ViewerCommandId, prefix: string) => id.startsWith(prefix);

/**
 * "?" and Help → Keyboard shortcuts: every command that has keys, in command order, grouped as the menus are. Each row
 * is the command's name (a row header) and its keys, each in a <kbd>.
 */
export function ShortcutsDialog({ open, onOpenChange, commands }: ShortcutsDialogProps) {
  const withKeys = [...commands.values()].filter((c) => c.keys.length > 0);
  const groups = GROUPS.map((g) => ({ ...g, rows: withKeys.filter((c) => inGroup(c.id, g.prefix)) })).filter((g) => g.rows.length > 0);
  return (
    <Dialog open={open} title="Keyboard shortcuts" onOpenChange={onOpenChange} actions={[{ label: 'Close', onClick: () => onOpenChange(false) }]}>
      <div className={styles.sheet}>
        {groups.map((g) => (
          <section key={g.prefix} className={styles.group} aria-labelledby={`shortcuts-${g.title}`}>
            <h3 id={`shortcuts-${g.title}`} className={styles.groupTitle}>
              {g.title}
            </h3>
            <table className={styles.table} aria-labelledby={`shortcuts-${g.title}`}>
              <tbody>
                {g.rows.map((c) => (
                  <tr key={c.id}>
                    <th scope="row" className={styles.action}>
                      {c.label}
                    </th>
                    <td className={styles.keys}>
                      {c.keys.map((k, i) => (
                        <Fragment key={k}>
                          {i > 0 && <span className={styles.or}>or</span>}
                          <kbd className={styles.kbd}>{formatCombo(k)}</kbd>
                        </Fragment>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
