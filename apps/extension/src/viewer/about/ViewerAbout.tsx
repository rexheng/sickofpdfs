// About this PDF in the viewer (R92): File → About this PDF, or the saved chip's "Tags and details…". A panel at the right,
// on the viewer's dark canvas, in the notes panel's place (opening one closes the other). For a PDF in the library it shows
// what the library's details panel shows; for any other PDF, what the file itself says, and nothing is saved.
import { type DocumentId } from '@sop/core';
import { IconButton, TextButton } from '@sop/ui';
import { useEffect, useMemo, useState } from 'react';
import { AboutDetails } from '../../library/about/AboutDetails';
import { createStoreAboutData } from '../../library/about/about-data';
import { ContextBox } from '../../library/about/ContextBox';
import { createContextKeeper } from '../../library/about/context-journal';
import { localDraftJournal } from '../annotations/draft-journal';
import { createStoreTagsData } from '../../library/tags/tags-data';
import { openTargetInNewTab } from '../../shared/palette';
import type { StoreClient } from '../../store/client';
import type { AnnotationSession } from '../annotations/session';
import type { ViewerUi } from '../commands';
import { notesPanel } from '../notes-panel/panel-state';
import type { OpenedDocument } from '../open-document';
import type { SaveControllerImpl } from '../save/save-controller';
import { useSaveView } from '../save/StatusChip';
import { libraryStore } from '../use-store';
import { aboutPanel, useAboutPanelOpen } from './about-panel-state';
import styles from './ViewerAbout.module.css';

export interface ViewerAboutProps {
  doc: OpenedDocument;
  save: SaveControllerImpl | null;
  /** The open document's notes; null in Incognito. */
  session: AnnotationSession | null;
  ui: Pick<ViewerUi, 'showNote'>;
}

export function ViewerAbout(p: ViewerAboutProps) {
  const open = useAboutPanelOpen();
  // One panel at a time on the right: the notes panel opening closes this one, and this one opening closes it.
  useEffect(() => notesPanel.subscribe(() => notesPanel.isOpen() && aboutPanel.close()), []);
  useEffect(() => {
    if (open) notesPanel.setOpen(false);
  }, [open]);
  useEffect(() => () => aboutPanel.close(), []);
  if (!open) return null;
  return <Panel {...p} />;
}

function Panel({ doc, save, session, ui }: ViewerAboutProps) {
  const { state } = useSaveView(save);
  const [store, setStore] = useState<StoreClient | null>(null);
  useEffect(() => {
    let live = true;
    void libraryStore().then((s) => live && setStore(s));
    return () => {
      live = false;
    };
  }, []);
  const about = useMemo(() => (store === null ? null : createStoreAboutData(store)), [store]);
  const tags = useMemo(() => (store === null ? null : createStoreTagsData(store)), [store]);
  // "Your context" journals every key under this tab's id, as the tab's own note drafts are, so after a crash the notes
  // session brings the words back when the PDF opens again (and the library's About can, if this tab is gone).
  const keeper = useMemo(() => (session === null ? null : createContextKeeper({ journal: localDraftJournal(), tabId: session.tabId, liveTabs: () => Promise.resolve([]) })), [session]);
  const savedId: DocumentId | null = state?.kind === 'saved' ? state.documentId : null;
  const say = (text: string, undo?: () => void) => ui.showNote(text, undo === undefined ? undefined : { label: 'Undo', run: undo });

  return (
    <aside
      className={styles.panel}
      aria-label="About this PDF"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          aboutPanel.close();
        }
      }}
    >
      <header className={styles.header}>
        <h2 className={styles.heading}>About this PDF</h2>
        <IconButton icon="close" size={40} iconSize={24} label="Close" onClick={() => aboutPanel.close()} />
      </header>
      <div className={styles.body}>
        {savedId !== null && about !== null ? (
          <AboutDetails
            key={savedId}
            documentId={savedId}
            about={about}
            tags={tags}
            say={say}
            contextBox={keeper === null ? null : <ContextBox about={about} documentId={savedId} keeper={keeper} recover={false} />}
            onOpenRelated={(r) => {
              if (store !== null) void openTargetInNewTab({ kind: 'reading', documentId: r.id }, store).then((problem) => problem !== null && ui.showNote(problem));
            }}
          />
        ) : (
          <NotSaved doc={doc} save={save} incognito={state?.kind === 'incognito'} checking={state === null || state.kind === 'checking' || (savedId !== null && about === null)} />
        )}
      </div>
    </aside>
  );
}

/** A PDF that is not in the library: what the file says about itself, and how to save it. Nothing here is stored. */
function NotSaved({ doc, save, incognito, checking }: { doc: OpenedDocument; save: SaveControllerImpl | null; incognito: boolean; checking: boolean }) {
  const title = doc.open.metadata.title?.trim();
  const source = doc.loaded.sourceUrl;
  return (
    <div className={styles.notSaved}>
      <p className={styles.title}>{title !== undefined && title !== '' ? title : doc.loaded.displayName}</p>
      <dl className={styles.facts}>
        <dt>File</dt>
        <dd>{doc.loaded.displayName}</dd>
        <dt>Pages</dt>
        <dd>{doc.open.pageCount}</dd>
        {source !== null && (
          <>
            <dt>Link</dt>
            <dd className={styles.link}>{source}</dd>
          </>
        )}
      </dl>
      {checking ? (
        <p className={styles.note}>Checking this PDF…</p>
      ) : incognito ? (
        <p className={styles.note}>Nothing is saved in an Incognito window, so this PDF has no tags or context here.</p>
      ) : (
        <>
          <p className={styles.note}>This PDF isn’t in your library. Save it to add tags, write why you are reading it, and find readings like it.</p>
          {save !== null && <TextButton label="Save to library" variant="tonal" icon="library_add" onClick={() => void save.requestSave().catch(() => {})} />}
        </>
      )}
    </div>
  );
}
