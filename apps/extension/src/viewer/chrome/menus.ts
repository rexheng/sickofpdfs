// The header's File, View, Tools and Help menus, built from the commands (commands.ts), and how a key combo is shown.
import type { MenuDef, MenuItemDef } from '@sop/ui';
import type { KeyCombo } from '../shortcuts';
import type { ViewerCommandId, ViewerCommands } from '../commands';

const SEPARATOR = '-';

/** A radio group: its heading (with the shortcut of `keysOf`, if any) and its choices, each a command with a check. */
interface RadioEntry {
  heading: string;
  keysOf: ViewerCommandId;
  choices: ViewerCommandId[];
}

/** Each menu's commands, with a separator between groups (Drive's dark viewer menus, 02 section 4.10). */
const LAYOUT: { id: string; label: string; items: (ViewerCommandId | typeof SEPARATOR | RadioEntry)[] }[] = [
  { id: 'file', label: 'File', items: ['file.startOver', SEPARATOR, 'file.openInChrome', 'file.openOriginal', SEPARATOR, 'file.download', 'file.copyLink', SEPARATOR, 'file.about', 'file.print', SEPARATOR, 'file.saveToLibrary', 'file.forget', 'file.reportDecision'] },
  {
    id: 'view',
    label: 'View',
    items: [
      'view.fitWidth', 'view.fitPage', 'view.zoomIn', 'view.zoomOut', SEPARATOR,
      'view.rotateCw', 'view.rotateCcw', SEPARATOR,
      'view.twoPage', 'view.presentation', SEPARATOR,
      // R90c: Bold word starts offers Off, Light, Medium and Strong directly; Alt+Shift+S turns it on and off.
      { heading: 'Bold word starts', keysOf: 'view.wordStarts', choices: ['view.wordStarts.off', 'view.wordStarts.light', 'view.wordStarts.medium', 'view.wordStarts.strong'] },
      'view.caretBrowsing', SEPARATOR,
      'notes.panel', // Shift+F4, with a tick while it is open (TB2/TB4 critics)
      'view.toggleRail',
    ],
  },
  { id: 'tools', label: 'Tools', items: ['tools.find', 'tools.goToPage', 'tools.search', 'tools.area', SEPARATOR, 'claude.wholeDocument'] },
  { id: 'help', label: 'Help', items: ['help.shortcuts', 'help.about'] },
];

/**
 * The menus as they are now: each item's greyed-out state, its reason and its check are read when this is called, so
 * build them again when the view changes. A command that is not registered, or not built yet (`built` false), is left
 * out, and so is a separator it leaves dangling.
 */
export function buildMenus(cmds: ViewerCommands): MenuDef[] {
  return LAYOUT.map((menu) => {
    const items: MenuItemDef[] = [];
    for (const entry of menu.items) {
      if (entry === SEPARATOR) {
        if (items.length > 0 && items.at(-1)?.kind !== 'separator') items.push({ kind: 'separator' });
        continue;
      }
      if (typeof entry !== 'string') {
        const owner = cmds.get(entry.keysOf);
        const choices = entry.choices.flatMap((id) => {
          const c = cmds.get(id);
          return c !== undefined && c.built ? [c] : [];
        });
        if (owner === undefined || !owner.built || choices.length === 0) continue;
        items.push({ kind: 'heading', id: `menu-heading-${entry.keysOf}`, label: entry.heading, ...(owner.keys[0] !== undefined ? { shortcut: formatCombo(owner.keys[0]) } : {}) });
        for (const c of choices) {
          items.push({
            kind: 'item',
            id: c.id,
            label: c.menuLabel ?? c.label,
            radio: entry.keysOf,
            checked: c.checked?.() === true,
            disabled: !c.enabled(),
            onSelect: () => {
              if (c.enabled()) c.run();
            },
          });
        }
        continue;
      }
      const cmd = cmds.get(entry);
      if (cmd === undefined || !cmd.built) continue;
      const checked = cmd.checked?.();
      const enabled = cmd.enabled();
      const why = enabled ? undefined : cmd.disabledReason?.();
      items.push({
        kind: 'item',
        id: cmd.id,
        label: cmd.label,
        ...(cmd.icon !== undefined ? { icon: cmd.icon } : {}),
        ...(cmd.keys[0] !== undefined ? { shortcut: formatCombo(cmd.keys[0]) } : {}),
        ...(checked !== undefined ? { checked } : {}),
        disabled: !enabled,
        ...(why !== undefined ? { disabledReason: why } : {}),
        onSelect: () => {
          if (cmd.enabled()) cmd.run();
        },
      });
    }
    if (items.at(-1)?.kind === 'separator') items.pop();
    return { id: menu.id, label: menu.label, items };
  });
}

/**
 * A combo as people read it: `Ctrl+=` and `Ctrl++` → `Ctrl+Plus` (the key marked + on every keyboard; "=" puzzled
 * people), `Ctrl+-` → `Ctrl+Minus`, `Alt+Shift+Digit5` → `Alt+Shift+5`, `Ctrl+Alt+KeyS` → `Ctrl+Alt+S`,
 * `Ctrl+s` → `Ctrl+S`.
 */
export function formatCombo(c: KeyCombo): string {
  const plusKey = c === '+' || c.endsWith('++');
  const head = plusKey ? c.slice(0, -1).replace(/\+$/u, '') : c;
  const parts = head === '' ? [] : head.split('+');
  const key = plusKey ? '+' : (parts.pop() ?? '');
  return [...parts, keyName(key)].join('+');
}

function keyName(key: string): string {
  if (key === '-' || key === '_') return 'Minus';
  if (key === '+' || key === '=') return 'Plus';
  if (key === 'ContextMenu') return 'Menu key';
  if (/^Digit\d$/u.test(key)) return key.slice('Digit'.length);
  if (/^Key[A-Z]$/u.test(key)) return key.slice('Key'.length);
  if (/^Numpad\w+$/u.test(key)) return `Num ${key.slice('Numpad'.length)}`;
  return key.length === 1 ? key.toUpperCase() : key;
}
