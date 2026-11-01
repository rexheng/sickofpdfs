import { FileTypeIcon, TextButton } from '@sop/ui';
import styles from './ViewerBar.module.css';

export interface ViewerBarProps {
  /** The PDF's name. */
  name: string;
  /** Shown for a PDF that was embedded in a page: back to that page. */
  onBack: (() => void) | null;
  /** The escape hatch, shown whenever there is an address to open. */
  onOpenInChrome: (() => void) | null;
  /** Chrome refused the escape (a local file without "Allow access to file URLs"). */
  chromeRefused: boolean;
}

/**
 * The viewer's top bar until Task 23 builds Drive's header: "Back to page" for an embedded PDF, the file's name, and
 * "Open in Chrome's viewer" (the spec's escape hatch: "an 'Open in Chrome's viewer' button is always there").
 */
export function ViewerBar({ name, onBack, onOpenInChrome, chromeRefused }: ViewerBarProps) {
  return (
    <header className={styles.bar}>
      {onBack !== null && <TextButton label="Back to page" icon="arrow_back" onClick={onBack} />}
      <FileTypeIcon kind="pdf" />
      <h1 className={styles.name}>{name}</h1>
      {chromeRefused && (
        <p role="alert" className={styles.alert}>
          Chrome cannot open this file. For a local file, turn on “Allow access to file URLs” for sickofpdfs.
        </p>
      )}
      {onOpenInChrome !== null && <TextButton label="Open in Chrome's viewer" icon="open_in_new" onClick={onOpenInChrome} />}
    </header>
  );
}
