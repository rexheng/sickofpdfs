// The header's File, View, Tools and Help menus, built from the commands (commands.ts), and how a key combo is shown.
import type { MenuDef, MenuItemDef } from '@sop/ui';
import type { KeyCombo } from '../shortcuts';
import type { ViewerCommandId, ViewerCommands } from '../commands';

const SEPARATOR = '-';

/** Each menu's commands, with a separator between groups (Drive's dark viewer menus, 02 section 4.10). */
const LAYOUT: { id: string; label: string; items: (ViewerCommandId | typeof SEPARATOR)[] }[] = [
  { id: 'file', label: 'File', items: ['file.openInChrome', SEPARATOR, 'file.download', 'file.copyLink', SEPARATOR, 'file.print', SEPARATOR, 'file.saveToLibrary'] },
  {
    id: 'view',
    label: 'View',
    items: [
      'view.fitWidth', 'view.fitPage', 'view.zoomIn', 'view.zoomOut', SEPARATOR,
      'view.rotateCw', 'view.rotateCcw', SEPARATOR,
      'view.twoPage', 'view.presentation', 'view.darkPages', SEPARATOR,
      'view.toggleRail',
    ],
  },
  { id: 'tools', label: 'Tools', items: ['tools.find', 'tools.goToPage'] },
  { id: 'help', label: 'Help', items: ['help.shortcuts', 'help.about'] },
];

/**
 * The menus as they are now: each item's greyed-out state and check are read when this is called, so build them again
 * when the view changes. A command that is not registered is left out, and so is a separator it leaves dangling.
 */
export function buildMenus(cmds: ViewerCommands): MenuDef[] {
  return LAYOUT.map((menu) => {
    const items: MenuItemDef[] = [];
    for (const entry of menu.items) {
      if (entry === SEPARATOR) {
        if (items.length > 0 && items.at(-1)?.kind !== 'separator') items.push({ kind: 'separator' });
        continue;
      }
      const cmd = cmds.get(entry);
      if (cmd === undefined) continue;
      const checked = cmd.checked?.();
      items.push({
        kind: 'item',
        id: cmd.id,
        label: cmd.label,
        ...(cmd.icon !== undefined ? { icon: cmd.icon } : {}),
        ...(cmd.keys[0] !== undefined ? { shortcut: formatCombo(cmd.keys[0]) } : {}),
        ...(checked !== undefined ? { checked } : {}),
        disabled: !cmd.enabled(),
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
 * A combo as people read it: `Ctrl+-` → `Ctrl+−` (a real minus sign), `Alt+Shift+Digit5` → `Alt+Shift+5`,
 * `Ctrl+Alt+KeyS` → `Ctrl+Alt+S`, `Ctrl+s` → `Ctrl+S`.
 */
export function formatCombo(c: KeyCombo): string {
  const plusKey = c === '+' || c.endsWith('++');
  const head = plusKey ? c.slice(0, -1).replace(/\+$/u, '') : c;
  const parts = head === '' ? [] : head.split('+');
  const key = plusKey ? '+' : (parts.pop() ?? '');
  return [...parts, keyName(key)].join('+');
}

function keyName(key: string): string {
  if (key === '-') return '−';
  if (/^Digit\d$/u.test(key)) return key.slice('Digit'.length);
  if (/^Key[A-Z]$/u.test(key)) return key.slice('Key'.length);
  if (/^Numpad\w+$/u.test(key)) return `Num ${key.slice('Numpad'.length)}`;
  return key.length === 1 ? key.toUpperCase() : key;
}
