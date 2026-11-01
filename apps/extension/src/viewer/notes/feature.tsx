// The comments (S14) as a viewer feature: App.tsx mounts it with one line, registerViewerFeature(commentsFeature).
//
// - Its commands, 'marks.comment' (Ctrl+Alt+M) and 'marks.documentNote' (Ctrl+Alt+Shift+M), are run by the viewer's
//   command list, which is the one listener for those keys. The notes layer publishes what they do while it is up.
// - Its view is the margin: cards beside the pages, pins and the note box. The cards hide while the notes panel (S15)
//   is open, and fold into the toolbar's Notes button when they do not fit beside the pages (ruling R69).
// - A PDF with no notes opens centred, as in Drive (ruling R79). A PDF that had notes last time opens with the margin's
//   room already kept beside its pages (R60), and, in a window where they fit only without the rail, with the rail
//   folded, so its pages never move once shown. The zoom never changes for the margin (R69).
import { isIncognito } from '../incognito';
import type { NotesHost, ViewerFeature } from '../annotations/wire';
import { MARGIN_RESERVE, marginNeedsRailAway } from './margin';
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

/** The rail's width beside the pages, and the page list's scroll bar, as the viewer lays them out at open. */
function openingRoom(): { width: number; height: number; rail: number } {
  const css = getComputedStyle(document.documentElement);
  const rail = parseFloat(css.getPropertyValue('--rail-w')) || 0;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;overflow:scroll;width:100px;height:100px';
  document.body.append(probe);
  const bar = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return { width: window.innerWidth - rail - bar, height: window.innerHeight, rail };
}

export const commentsFeature: ViewerFeature = {
  id: 'comments',
  commands: () => ({ 'marks.comment': delegate('marks.comment'), 'marks.documentNote': delegate('marks.documentNote') }),
  View: CommentsView,
  reserveAtOpen: (doc) => (!isIncognito() && hadNotes(doc.loaded.sha256) ? MARGIN_RESERVE : 0),
  foldsRailAtOpen: (doc) => !isIncognito() && hadNotes(doc.loaded.sha256) && marginNeedsRailAway(doc.open.pages, openingRoom()),
};
