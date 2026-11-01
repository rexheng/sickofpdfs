import { FileTypeIcon, IconButton, MenuBar, type MenuDef } from '@sop/ui';
import type { ReactNode } from 'react';
import styles from './Header.module.css';

export interface HeaderProps {
  /** The PDF's name. */
  name: string;
  /** "Back to page", for a PDF that was embedded in a page; null hides it. */
  onBack: (() => void) | null;
  menus: MenuDef[];
  /** The escape hatch at the right; null hides it (the error card then carries its own). */
  onOpenInChrome: (() => void) | null;
  /** Chrome refused the escape (a local file without "Allow access to file URLs"). */
  chromeRefused: boolean;
  /** The library status chip (Task 30). */
  status?: ReactNode;
}

/**
 * Drive's PDF preview header (02 section 4.10), 64 px on the viewer canvas: "Back to page" where Drive has its close
 * button (a 32 px button with a 24 px icon), the 24 px PDF tile, the file name in Google Sans 18 with the File, View,
 * Tools and Help menus under it, and at the right the status chip and "Open in Chrome's viewer" where Drive has
 * "Open in new tab". The spec's escape hatch "is always there": File → Open in Chrome's viewer and this button.
 */
export function Header({ name, onBack, menus, onOpenInChrome, chromeRefused, status }: HeaderProps) {
  return (
    <header className={styles.header} data-theme="dark" data-viewer-chrome="">
      {onBack !== null && <IconButton icon="arrow_back" label="Back to page" size={32} iconSize={24} onClick={onBack} className={styles.back} />}
      <span className={styles.tile}>
        <FileTypeIcon kind="pdf" size={32} />
      </span>
      <div className={styles.titles}>
        <h1 className={styles.name} title={name}>
          {name}
        </h1>
        <div className={styles.menus}>
          <MenuBar menus={menus} />
        </div>
      </div>
      <div className={styles.end}>
        {chromeRefused && (
          <p role="alert" className={styles.alert}>
            Chrome cannot open this file. For a local file, turn on “Allow access to file URLs” for sickofpdfs.
          </p>
        )}
        {status}
        {onOpenInChrome !== null && (
          <IconButton icon="open_in_new" label="Open in Chrome's viewer" size={40} iconSize={20} onClick={onOpenInChrome} />
        )}
      </div>
    </header>
  );
}
