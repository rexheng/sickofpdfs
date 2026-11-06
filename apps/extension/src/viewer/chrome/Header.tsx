import { FileTypeIcon, IconButton, MenuBar, type MenuDef, TextButton, Tooltip } from '@sop/ui';
import type { ReactNode } from 'react';
import styles from './Header.module.css';

export interface HeaderProps {
  /** The PDF's name: the reading's title once known, else its file name (reading-title.ts). */
  name: string;
  /** The name's tooltip: the whole title and the file name. Defaults to `name`. */
  hint?: string;
  /** "Back to page", for a PDF that was embedded in a page; null hides it. */
  onBack: (() => void) | null;
  menus: MenuDef[];
  /** The escape hatch at the right; null hides it (the error card then carries its own). */
  onOpenInChrome: (() => void) | null;
  /** Chrome refused the escape (a local file without "Allow access to file URLs"). */
  chromeRefused: boolean;
  /** The library status chip (Task 30). */
  status?: ReactNode;
  /** Where the focus goes after a menu was used with the pointer: the pages (App.tsx). */
  returnFocus?: () => void;
}

/**
 * Drive's PDF preview header (02 section 4.10), made compact as Google Docs' title block (TB6): 44 px on the viewer
 * canvas. "Back to page" where Drive has its close button (in words, with its arrow: an arrow alone read as the
 * browser's own Back), the 24 px PDF tile, the PDF's name (its title once known, else the file name; TB4) in Google Sans
 * 18 with the File, View, Tools and Help menus tight under it, and at the right the status chip and "Open in Chrome's
 * viewer" where Drive has "Open in new tab". The spec's escape hatch "is always there": File → Open in Chrome's viewer
 * and this button.
 */
export function Header({ name, hint = name, onBack, menus, onOpenInChrome, chromeRefused, status, returnFocus }: HeaderProps) {
  return (
    <header className={styles.header} data-theme="dark" data-viewer-chrome="" data-viewer-back={onBack !== null ? '' : undefined}>
      {onBack !== null && (
        <Tooltip label="Go back to the web page this PDF was in">
          <TextButton icon="arrow_back" label="Back to page" onClick={onBack} className={styles.back} />
        </Tooltip>
      )}
      <span className={styles.tile}>
        <FileTypeIcon kind="pdf" size={32} />
      </span>
      <div className={styles.titles}>
        <h1 className={styles.name} title={hint}>
          {name}
        </h1>
        <div className={styles.menus}>
          <MenuBar menus={menus} {...(returnFocus !== undefined ? { returnFocus } : {})} />
        </div>
      </div>
      <div className={styles.end}>
        {chromeRefused && (
          <p role="alert" className={styles.alert}>
            Chrome can’t open this file. For a file on your computer, turn on “Allow access to file URLs” for sickofpdfs.
          </p>
        )}
        {status}
        {onOpenInChrome !== null && (
          <IconButton icon="open_in_new" label="Open in Chrome’s viewer" onClick={onOpenInChrome} />
        )}
      </div>
    </header>
  );
}
