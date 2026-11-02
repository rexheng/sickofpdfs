// The comments (S14) as a viewer feature: App.tsx mounts it with one line, registerViewerFeature(commentsFeature).
//
// - Its commands, 'marks.comment' (Ctrl+Alt+M) and 'marks.documentNote' (Ctrl+Alt+Shift+M), are run by the viewer's
//   command list, which is the one listener for those keys. The notes layer publishes what they do while it is up.
// - Its view is the margin: cards beside the pages, pins and the note box. The cards hide while the notes panel (S15)
//   is open, and fold into the toolbar's Notes button when they do not fit beside the pages (ruling R69).
// - A PDF with no notes opens centred, as in Drive (ruling R79). A PDF that had notes last time opens with the margin's
//   room already kept beside its pages (R60), moving them at most 120 px (R98), so its pages never move once shown.
//   Where that is not room enough, the notes show as numbered markers. Neither the zoom (R69) nor the rail (R98) ever
//   changes for the margin.
import { isIncognito } from '../incognito';
import type { NotesHost, ViewerFeature } from '../annotations/wire';
import { MARGIN_MAX_SHIFT, MARGIN_RESERVE } from './margin';
import { hadNotes } from './margin-at-open';
import { NotesLayer } from './NotesLayer';
import { type NoteCommandId } from './note-commands';
import { noteCommands } from './notes-host';

function delegate(id: NoteCommandId) {
  return {
    run: () => noteCommands()?.[id].run(),
    enabled: () => noteCommands()?.[id].enabled() ?? false,
  };
}

function CommentsView({ host }: { host: NotesHost }) {
  return <NotesLayer host={host} />;
}

export const commentsFeature: ViewerFeature = {
  id: 'comments',
  commands: () => ({ 'marks.comment': delegate('marks.comment'), 'marks.documentNote': delegate('marks.documentNote') }),
  View: CommentsView,
  reserveAtOpen: (doc) => (!isIncognito() && hadNotes(doc.loaded.sha256) ? { px: MARGIN_RESERVE, maxShift: MARGIN_MAX_SHIFT } : null),
};
