// The comments (S14) as a viewer feature: App.tsx mounts it with one line, registerViewerFeature(commentsFeature).
//
// - Its commands, 'marks.comment' (Ctrl+Alt+M) and 'marks.documentNote' (Ctrl+Alt+Shift+M), are run by the viewer's
//   command list, which is the one listener for those keys. The notes layer publishes what they do while it is up.
// - Its view is the margin: cards beside the pages, pins and the note box. The margin hides while the notes panel
//   (S15) holds the cards: while the panel is open, and in a window too narrow for margin cards.
// - Ruling R60: a saved PDF that had notes the last time it was open here opens with its margin already there.
import { useLayoutEffect } from 'react';
import { isIncognito } from '../incognito';
import type { NotesHost, ViewerFeature } from '../annotations/wire';
import { useCardsFolded, useNotesPanelOpen } from '../notes-panel';
import { MARGIN_RESERVE } from './margin';
import { hadNotes } from './margin-at-open';
import { NotesLayer } from './NotesLayer';
import { type NoteCommandId } from './note-commands';
import { noteCommands, setMarginFolded } from './notes-host';

function delegate(id: NoteCommandId) {
  return {
    run: () => noteCommands()?.[id].run(),
    enabled: () => noteCommands()?.[id].enabled() ?? false,
  };
}

function CommentsView({ host }: { host: NotesHost }) {
  const panelOpen = useNotesPanelOpen();
  const narrow = useCardsFolded();
  const folded = panelOpen || narrow;
  useLayoutEffect(() => setMarginFolded(folded), [folded]);
  useLayoutEffect(() => () => setMarginFolded(false), []);
  return <NotesLayer host={host} />;
}

export const commentsFeature: ViewerFeature = {
  id: 'comments',
  commands: () => ({ 'marks.comment': delegate('marks.comment'), 'marks.documentNote': delegate('marks.documentNote') }),
  View: CommentsView,
  reserveAtOpen: (doc) => (!isIncognito() && hadNotes(doc.loaded.sha256) ? MARGIN_RESERVE : 0),
};
