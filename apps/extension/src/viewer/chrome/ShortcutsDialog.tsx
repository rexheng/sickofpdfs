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
  { title: 'In presentation mode', prefix: 'presenting.' },
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
  /** For a row with no key: where to find it instead ("View menu"). */
  where?: string;
}

/** View commands with no key that the sheet still lists, so it names every view (Task 26): where to find them. */
const KEYLESS: Partial<Record<string, string>> = { 'view.twoPage': 'View menu', 'view.presentation': 'View menu' };

/** The keys that move the pages (App.tsx readerShortcuts), as Chrome's viewer has them. They work while reading. */
const READING: Row[] = [
  { id: 'reading.down', label: 'Down a screen', keys: ['Space', 'Page Down'] },
  { id: 'reading.up', label: 'Up a screen', keys: ['Shift+Space', 'Page Up'] },
  { id: 'reading.lines', label: 'Scroll a little', keys: ['↓', '↑'] },
  { id: 'reading.ends', label: 'First page, last page', keys: ['Home', 'End'] },
  { id: 'reading.zoom', label: 'Zoom with the mouse wheel', keys: ['Ctrl+wheel'] },
];

/** The keys of presentation mode (presentation.ts): the reading keys step one page there. */
const PRESENTING: Row[] = [
  { id: 'presenting.next', label: 'Next page, or click the right half', keys: ['→', '↓', 'Space', 'Page Down'] },
  { id: 'presenting.previous', label: 'Previous page, or click the left half', keys: ['←', '↑', 'Shift+Space', 'Page Up'] },
  { id: 'presenting.ends', label: 'First page, last page', keys: ['Home', 'End'] },
  { id: 'presenting.leave', label: 'Leave presentation mode', keys: ['Esc'] },
];

/** The keys of a mark that was clicked (mark-input.ts): not commands of their own, so they are listed here. */
const FOCUSED_MARK: Row[] = [
  { id: 'marks.focused.colour', label: 'Change a clicked mark’s colour', keys: ['1–5'] },
  { id: 'marks.focused.delete', label: 'Remove a clicked mark', keys: ['Delete'] },
  { id: 'marks.focused.step', label: 'Go to the next or previous mark', keys: ['Tab', 'Shift+Tab'] },
];

/**
 * "?" and Help → Keyboard shortcuts: the reading keys, then every command that has keys and works (`built`), in
 * command order, grouped as the menus are; two-page view and presentation mode too, with where to find them. Each
 * row is the command's name (a row header) and its keys, each in a <kbd>. Two keys that read the same (Ctrl+= and
 * Ctrl++ are both "Ctrl+Plus") show once.
 */
export function ShortcutsDialog({ open, onOpenChange, commands }: ShortcutsDialogProps) {
  const rows: Row[] = [
    ...READING,
    ...[...commands.values()]
      .filter((c) => c.built && (c.keys.length > 0 || KEYLESS[c.id] !== undefined))
      .map((c) => ({ id: c.id, label: c.label, keys: [...new Set(c.keys.map(formatCombo))], ...(c.keys.length === 0 ? { where: KEYLESS[c.id] } : {}) })),
    ...(commands.get('view.presentation')?.built === true ? PRESENTING : []),
    // Marks exist only where they can be made (not in Incognito).
    ...(commands.get('marks.highlight')?.built === true ? FOCUSED_MARK : []),
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
                      {c.where !== undefined && <span className={styles.or}>{c.where}</span>}
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
