// The mark-up menu (Phase 2, S13): S6's dark ContextMenu at the pointer, with the colour row, Highlight, Underline,
// Bold, Strikethrough, Comment, Search and Copy. It opens only for a selection (mark-input.ts decides when), and every
// row acts on the chars that were selected when it opened. Ask Claude joins it in Phase 4.
//
// The same dark menu, for one mark (ruling R72), opens on a right-click on a mark, or the menu key on a focused mark:
// the colour row (keys 1 to 5), Comment and Remove (Delete), with the keys shown in the rows. An area mark has it too,
// and never the figure menu as well (R80): it has no colour slot, so no colour row, and Remove reads "Remove area".
//
// The open state lives here, apart from the page list, so opening and closing the menu re-renders only this.
import type { MarkColor, MarkStyle } from '@sop/core';
import { ContextMenu, MARK_COLOR_NAMES, type MenuItemDef } from '@sop/ui';
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

/** What a mark is called in its menu. */
const MARK_WORDS: Record<MarkStyle, string> = { highlight: 'highlight', underline: 'underline', bold: 'bold', strike: 'strikethrough', area: 'area' };

/** A menu row for a viewer command: its name, icon and first key, as the File menu shows them. */
function commandRow(commands: ViewerCommands, id: ViewerCommandId, run: () => void, enabled = true): MenuItemDef[] {
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
}

function selectionItems(req: Extract<MenuRequest, { kind: 'selection' }>, input: MarkInput, commands: ViewerCommands): MenuItemDef[] {
  const row = (id: ViewerCommandId, run: () => void, enabled = true) => commandRow(commands, id, run, enabled);
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

function markItems(req: Extract<MenuRequest, { kind: 'mark' }>, input: MarkInput, commands: ViewerCommands): MenuItemDef[] {
  const mark = input.mark(req.id);
  if (mark === null) return [];
  const comment = commands.get('marks.comment');
  const commentRow =
    comment === undefined
      ? []
      : [
          ...commandRow(
            commands,
            'marks.comment',
            () => {
              // An area mark is focused (the menu focused it): Ctrl+Alt+M's own flow makes the note on it, or opens the
              // one it has (S16, R80).
              if (mark.style === 'area') return comment.run();
              // Comment acts on the selection: the mark's own text becomes it, then the note opens on those words (or
              // the note already there). The mark stays as it is (R68).
              if (input.selectText(req.id)) comment.run();
            },
            comment.enabled(),
          ),
          { kind: 'separator' as const },
        ];
  return [
    ...commentRow,
    // The hint is the key that does the same on a focused mark.
    { kind: 'item', id: 'mark.remove', label: `Remove ${MARK_WORDS[mark.style]}`, icon: 'delete', shortcut: 'Delete', onSelect: () => input.remove(req.id) },
  ];
}

/** The menu's accessible name: "Mark up" for a selection; what the mark is for the mark menu ("Green highlight"). */
function menuLabel(input: MarkInput, req: MenuRequest | null): string {
  if (req?.kind !== 'mark') return 'Mark up';
  const m = input.mark(req.id);
  if (m === null) return 'Mark';
  const what = m.color === null ? MARK_WORDS[m.style] : `${MARK_COLOR_NAMES[m.color]} ${MARK_WORDS[m.style]}`;
  return `${what[0]?.toUpperCase() ?? ''}${what.slice(1)}`;
}

type Swatches = { value: MarkColor; onPick(this: void, c: MarkColor): void };

export function MarkupMenu({ input, commands }: MarkupMenuProps) {
  const req = useSyncExternalStore(input.menu.subscribe, input.menu.get);
  // While the menu closes it keeps the rows it opened with.
  const [shown, setShown] = useState<MenuRequest | null>(req);
  if (req !== null && req !== shown) setShown(req);
  const items = useMemo(
    () => (shown === null ? [] : shown.kind === 'mark' ? markItems(shown, input, commands) : selectionItems(shown, input, commands)),
    [shown, input, commands],
  );
  const swatches = useMemo((): Swatches | null => {
    if (shown === null) return { value: 1, onPick: () => {} };
    if (shown.kind === 'selection') return { value: input.menuColour(shown.ranges), onPick: (c) => input.apply('highlight', { color: c, ranges: shown.ranges }) };
    // A mark's colour row recolours it; a bold mark has no colour, so no row.
    const colour = input.mark(shown.id)?.color ?? null;
    return colour === null ? null : { value: colour, onPick: (c) => input.recolor(shown.id, c) };
  }, [shown, input]);
  return (
    <ContextMenu
      at={req?.at ?? null}
      items={items}
      {...(swatches !== null ? { swatches } : {})}
      label={menuLabel(input, shown)}
      onClose={input.menu.close}
    />
  );
}
