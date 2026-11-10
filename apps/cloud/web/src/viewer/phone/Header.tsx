// The web's version of apps/extension/src/viewer/chrome/Header.tsx (swapped in by vite.config.ts; same props).
//   - On a phone: the phone app's header (apps/mobile/src/phone/PhoneHeader.tsx), with the cloud's save status beside the
//     library chip.
//   - On a computer: the extension's header, as Drive's PDF preview, with two changes for the web. "Back to library" where the
//     extension has "Back to page" (it goes to the reading's page here), and "Download" where the extension has "Open in
//     Chrome's viewer" (there is no Chrome viewer to hand the PDF to from a web page). The cloud's save status ("Saving…",
//     "Saved", "Offline, not saved") sits next to the library chip.
import { FileTypeIcon, IconButton, MenuBar, TextButton, Tooltip } from '@sop/ui';
import type { HeaderProps } from '@ext/viewer/chrome/Header';
import { Header as PhoneHeader } from '@mobile/phone/PhoneHeader';
import styles from '@ext/viewer/chrome/Header.module.css';
import { SyncStatusChip } from '../../platform/SyncStatus';
import { leaveViewer } from '../back';
import { downloadPdf } from '../download';
import { PHONE_LAYOUT } from '../layout';
import own from './Header.module.css';

export type { HeaderProps } from '@ext/viewer/chrome/Header';

export function Header(p: HeaderProps) {
  const status = (
    <span className={own.status}>
      {p.status}
      <span className={own.sync}>
        <SyncStatusChip compact />
      </span>
    </span>
  );
  if (PHONE_LAYOUT) return <PhoneHeader {...p} status={status} />;
  return <WebHeader {...p} status={status} />;
}

function WebHeader({ name, hint = name, menus, status, returnFocus, menusHidden = false }: HeaderProps) {
  return (
    <header className={styles.header} data-theme="dark" data-viewer-chrome="" data-viewer-back="" data-menus-hidden={menusHidden ? '' : undefined}>
      <Tooltip label="Back to this reading in your library">
        <TextButton icon="arrow_back" label="Library" onClick={leaveViewer} className={styles.back} />
      </Tooltip>
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
        {status}
        <IconButton icon="download" label="Download this PDF" onClick={() => downloadPdf()} />
      </div>
    </header>
  );
}
