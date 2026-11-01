// The mark-up menu (Phase 2, S13): S6's dark ContextMenu at the pointer, with the colour row, Highlight, Underline,
// Bold, Strikethrough, Comment, Search and Copy. It opens only for a selection (mark-input.ts decides when), and every
// row acts on the chars that were selected when it opened. Ask Claude joins it in Phase 4.
//
// The open state lives here, apart from the page list, so opening and closing the menu re-renders only this.
import { ContextMenu, type MenuItemDef } from '@sop/ui';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { openSearch, searchTarget } from '../actions/search-web';
import { formatCombo } from '../chrome/menus';
import type { ViewerCommandId, ViewerCommands } from '../commands';
import type { MarkInput, MenuRequest } from './mark-input';
import './modal-layers.css';

export interface MarkupMenuProps {
  input: MarkInput;
  commands: ViewerCommands;
}

/** Copies the selection the way Ctrl+C does: the text layer writes PDFium's text of the selected chars (R26). */
function copySelection(): void {
  // execCommand('copy') runs the page's own copy handler (TextLayerController.onCopy), so the menu and Ctrl+C copy the
  // same text. The menu runs this in the same task as the click, which is the user gesture it needs.
  document.execCommand('copy');
}

function buildItems(req: MenuRequest, input: MarkInput, commands: ViewerCommands): MenuItemDef[] {
  const row = (id: ViewerCommandId, run: () => void, enabled = true): MenuItemDef[] => {
    const cmd = commands.get(id);
    if (cmd === undefined) return [];
    const key = cmd.keys[0];
    return [
      {
        kind: 'item',
        id,
        label: cmd.label,
        ...(cmd.icon !== undefined ? { icon: cmd.icon } : {}),
        ...(key !== undefined ? { shortcut: formatCombo(key) } : {}),
        disabled: !enabled,
        onSelect: run,
      },
    ];
  };
  const { ranges } = req;
  const comment = commands.get('marks.comment');
  const search = searchTarget(req.text);
  return [
    ...row('marks.highlight', () => input.apply('highlight', { ranges })),
    ...row('marks.underline', () => input.apply('underline', { ranges })),
    ...row('marks.bold', () => input.apply('bold', { ranges })),
    ...row('marks.strike', () => input.apply('strike', { ranges })),
    { kind: 'separator' },
    // Comment is S14's command: it reads the selection itself, which the menu leaves in place.
    ...row('marks.comment', () => comment?.run(), comment?.enabled() === true),
    { kind: 'separator' },
    ...(search === null ? [] : [{ kind: 'item' as const, id: 'search', label: search.label, icon: 'search' as const, onSelect: () => void openSearch(search) }]),
    { kind: 'item', id: 'copy', label: 'Copy', icon: 'content_copy', shortcut: 'Ctrl+C', onSelect: copySelection },
  ];
}

export function MarkupMenu({ input, commands }: MarkupMenuProps) {
  const req = useSyncExternalStore(input.menu.subscribe, input.menu.get);
  // While the menu closes it keeps the rows it opened with.
  const [shown, setShown] = useState<MenuRequest | null>(req);
  if (req !== null && req !== shown) setShown(req);
  const items = useMemo(() => (shown === null ? [] : buildItems(shown, input, commands)), [shown, input, commands]);
  const colour = useMemo(() => (shown === null ? 1 : input.menuColour(shown.ranges)), [shown, input]);
  return (
    <ContextMenu
      at={req?.at ?? null}
      items={items}
      swatches={{ value: colour, onPick: (c) => shown !== null && input.apply('highlight', { color: c, ranges: shown.ranges }) }}
      onClose={input.menu.close}
    />
  );
}
