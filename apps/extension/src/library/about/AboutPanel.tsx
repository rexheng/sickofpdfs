// The library's details panel (R92 "About this PDF"), as Drive's file details: a white card at the right of the list,
// opened from a row's menu, the title row's (i) button or the "i" key. It follows the selected reading.
import type { DocumentId } from '@sop/core';
import { FileTypeIcon, IconButton } from '@sop/ui';
import { useState } from 'react';
import { useLibrary } from '../app/context';
import { CardThumbnail } from '../components/CardThumbnail';
import { openTargetInNewTab } from '../../shared/palette';
import { sayWith } from '../tags/say';
import { AboutDetails } from './AboutDetails';
import styles from './AboutPanel.module.css';
import { ContextBox } from './ContextBox';
import { libraryContextKeeper } from './context-journal';

export interface AboutPanelProps {
  /** The reading it is about; null: none is selected. */
  documentId: DocumentId | null;
  onClose(this: void): void;
}

export function AboutPanel({ documentId, onClose }: AboutPanelProps) {
  const { data, notify } = useLibrary();
  const say = sayWith(notify);
  const [keeper] = useState(libraryContextKeeper); // this page's tab id, as the viewer's drafts have theirs
  const about = data.about;
  return (
    <aside
      className={styles.panel}
      aria-label="About this PDF"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header className={styles.header}>
        <FileTypeIcon kind="pdf" size={24} />
        <h2 className={styles.heading}>About this PDF</h2>
        <IconButton icon="close" size={40} label="Close details" onClick={onClose} />
      </header>
      <div className={styles.body}>
        {about === undefined ? (
          <p className={styles.empty}>Details aren’t available in this sample library.</p>
        ) : documentId === null ? (
          <div className={styles.none}>
            <p className={styles.emptyTitle}>Select a reading to see its details</p>
            <p className={styles.empty}>Its tags, why you are reading it, where it came from and readings like it.</p>
          </div>
        ) : (
          <AboutDetails
            key={documentId}
            documentId={documentId}
            about={about}
            tags={data.tags ?? null}
            say={say}
            thumbnail={(stored) => <CardThumbnail id={documentId} stored={stored} />}
            contextBox={<ContextBox about={about} documentId={documentId} keeper={keeper} recover />}
            onOpenRelated={(r) => {
              const store = data.palette;
              if (store === undefined) return;
              void openTargetInNewTab({ kind: 'reading', documentId: r.id }, store).then((problem) => problem !== null && say(problem));
            }}
          />
        )}
      </div>
    </aside>
  );
}
