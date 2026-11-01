import { Dialog } from '@sop/ui';
import { Fragment } from 'react';
import type { ViewerCommands } from '../commands';
import { formatCombo } from './menus';
import styles from './ShortcutsDialog.module.css';

export interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange(this: void, open: boolean): void;
  commands: ViewerCommands;
}

/** The sheet's groups: reading first, then as the header's menus, then the marks and notes (Phase 2) and undo. */
const GROUPS: { title: string; prefix: string; also?: string[] }[] = [
  { title: 'Reading', prefix: 'reading.' },
  { title: 'File', prefix: 'file.' },
  { title: 'View', prefix: 'view.' },
  { title: 'Tools', prefix: 'tools.' },
  { title: 'Marks and notes', prefix: 'marks.', also: ['notes.', 'figures.'] },
  { title: 'Edit', prefix: 'edit.' },
  { title: 'Help', prefix: 'help.' },
];

const inGroup = (id: string, g: (typeof GROUPS)[number]) => [g.prefix, ...(g.also ?? [])].some((p) => id.startsWith(p));

interface Row {
  id: string;
  label: string;
  /** As people read them (formatCombo), each once. */
  keys: string[];
}

/** The keys that move the pages (App.tsx readerShortcuts), as Chrome's viewer has them. They work while reading. */
const READING: Row[] = [
  { id: 'reading.down', label: 'Down a screen', keys: ['Space', 'Page Down'] },
  { id: 'reading.up', label: 'Up a screen', keys: ['Shift+Space', 'Page Up'] },
  { id: 'reading.lines', label: 'Scroll a little', keys: ['↓', '↑'] },
  { id: 'reading.ends', label: 'First page, last page', keys: ['Home', 'End'] },
  { id: 'reading.zoom', label: 'Zoom with the mouse wheel', keys: ['Ctrl+wheel'] },
];

/**
 * "?" and Help → Keyboard shortcuts: the reading keys, then every command that has keys and works (`built`), in
 * command order, grouped as the menus are. Each row is the command's name (a row header) and its keys, each in a
 * <kbd>. Two keys that read the same (Ctrl+= and Ctrl++ are both "Ctrl+Plus") show once.
 */
export function ShortcutsDialog({ open, onOpenChange, commands }: ShortcutsDialogProps) {
  const rows: Row[] = [
    ...READING,
    ...[...commands.values()]
      .filter((c) => c.built && c.keys.length > 0)
      .map((c) => ({ id: c.id, label: c.label, keys: [...new Set(c.keys.map(formatCombo))] })),
  ];
  const groups = GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => inGroup(r.id, g)) })).filter((g) => g.rows.length > 0);
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
                          <kbd className={styles.kbd}>{k}</kbd>
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
