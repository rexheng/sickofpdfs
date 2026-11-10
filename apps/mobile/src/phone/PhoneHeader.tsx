// The viewer's header on a phone (swapped in for apps/extension/src/viewer/chrome/Header.tsx by vite.config.ts; same props).
// Drive's mobile PDF viewer: one 56 px row on the dark canvas. Back (to the library) at the left, the PDF's name, then the
// library status as a small chip, the Notes button with its count, and ⋮. Every control is at least 48 px for a thumb.
//
// The ⋮ menu holds what makes sense on a phone, taken from the viewer's own menus (so each row's state and wording are the
// extension's), without keyboard shortcuts, plus "Listen with ElevenReader" (R112), which shares the open PDF to that app.
import type { HeaderProps } from '@ext/viewer/chrome/Header';
import { useNotesButton } from '@ext/viewer/notes-panel/panel-state';
import { DropdownMenu, Icon, type MenuItemDef } from '@sop/ui';
import { useMemo } from 'react';
import { homeUrl } from '../platform/app-events';
import { listenWithElevenReader } from './elevenreader';
import styles from './PhoneHeader.module.css';

export type { HeaderProps } from '@ext/viewer/chrome/Header';

/** The rows of the ⋮ menu, by the viewer's own item ids, in order; '-' is a separator. */
const PHONE_ROWS: string[] = [
  'tools.find',
  'tools.goToPage',
  '-',
  'view.fitWidth',
  'view.fitPage',
  'view.rotateCw',
  'view.resetPageOrder',
  'menu-heading-view.wordStarts',
  '-',
  'claude.wholeDocument',
  'tools.elevenReader',
  '-',
  'file.saveToLibrary',
  'file.reportDecision',
  'file.forget',
  'file.startOver',
  'file.about',
];

/** Leaves the viewer: back to the page before it, or to the library when the viewer was the first page (a PDF from "Open with"). */
function leave(): void {
  if (history.length > 1) history.back();
  else location.assign(homeUrl());
}

/** A row without its keyboard shortcut (a phone has no keyboard to press it on). */
function noKeys<T extends { shortcut?: string }>(row: T): T {
  const copy = { ...row };
  delete copy.shortcut;
  return copy;
}

/** The phone's ⋮ rows, picked from the viewer's menus. A radio heading brings its choices with it. */
export function phoneRows(menus: HeaderProps['menus']): MenuItemDef[] {
  const all = menus.flatMap((m) => m.items);
  const rows: MenuItemDef[] = [];
  for (const id of PHONE_ROWS) {
    if (id === '-') {
      if (rows.length > 0 && rows.at(-1)?.kind !== 'separator') rows.push({ kind: 'separator' });
      continue;
    }
    if (id === 'tools.elevenReader') {
      rows.push({ kind: 'item', id, label: 'Listen with ElevenReader', icon: 'headphones', tag: 'Sponsor', onSelect: () => void listenWithElevenReader() });
      continue;
    }
    const at = all.findIndex((r) => r.kind !== 'separator' && r.id === id);
    const row = all[at];
    if (row === undefined) continue;
    if (row.kind === 'heading') {
      rows.push(noKeys(row));
      for (const choice of all.slice(at + 1)) {
        if (choice.kind !== 'item' || choice.radio === undefined) break;
        rows.push(choice);
      }
      continue;
    }
    if (row.kind === 'item') {
      rows.push(noKeys(row));
    }
  }
  if (rows.at(-1)?.kind === 'separator') rows.pop();
  return rows;
}

export function Header({ name, hint = name, menus, status, menusHidden = false }: HeaderProps) {
  const rows = useMemo(() => phoneRows(menus), [menus]);
  const notes = useNotesButton();
  return (
    <header className={styles.header} data-theme="dark" data-viewer-chrome="" data-phone-header="" data-menus-hidden={menusHidden ? '' : undefined}>
      <button type="button" className={styles.button} aria-label="Back to library" onClick={leave}>
        <Icon name="arrow_back" />
      </button>
      <h1 className={styles.name} title={hint}>
        {name}
      </h1>
      <div className={styles.status}>{status}</div>
      {notes !== null && (
        <button type="button" className={styles.button} aria-label={notes.count === 1 ? 'Notes, 1 note' : `Notes, ${notes.count} notes`} onClick={notes.toggle}>
          <Icon name="comment" />
          {notes.count > 0 && <span className={styles.badge}>{notes.count > 99 ? '99+' : notes.count}</span>}
        </button>
      )}
      <DropdownMenu
        align="end"
        items={rows}
        trigger={
          <button type="button" className={styles.button} aria-label="More">
            <Icon name="more_vert" />
          </button>
        }
      />
    </header>
  );
}
