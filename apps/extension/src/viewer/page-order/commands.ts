// R108: the commands page moves take part in. Ctrl+Z and Ctrl+Y undo and redo whichever came last in this tab, a page
// move or a note (edit-journal.ts); View → Reset page order puts the file's own order back; and Shift+F10 on a focused
// thumbnail opens the thumbnails' menu, not the mark-up menu.
import type { CommandBehaviour, ViewerCommandId } from '../commands';
import type { PageOrderController } from './controller';
import { nextRedo, nextUndo, tookRedo, tookUndo } from './edit-journal';

type Behaviours = Partial<Record<ViewerCommandId, CommandBehaviour>>;

/** The focus is on a thumbnail: its keys are the rail's. */
const inThumbnails = (): boolean => document.activeElement instanceof HTMLElement && document.activeElement.closest('[aria-label="Thumbnails"]') !== null;

/** `notes` are the notes' own behaviours (undo, redo, the mark-up menu); null in a tab with no notes (Incognito). */
export function pageOrderBehaviours(pages: PageOrderController, notes: Behaviours | null): Behaviours {
  const notesUndo = notes?.['edit.undo'];
  const notesRedo = notes?.['edit.redo'];
  const markMenu = notes?.['marks.menu'];
  const undoGoesToPages = () => nextUndo() === 'pages' && pages.canUndo();
  const redoGoesTo = (): 'pages' | 'notes' | null => {
    const k = nextRedo();
    return k === 'pages' ? (pages.canRedo() ? 'pages' : null) : k;
  };
  return {
    'view.resetPageOrder': { run: () => void pages.reset(), enabled: () => pages.order() !== null, disabledReason: () => 'the pages are in their first order' },
    'edit.undo': {
      run: () => {
        if (undoGoesToPages()) {
          tookUndo('pages');
          pages.undo();
          return;
        }
        tookUndo('notes');
        notesUndo?.run();
      },
      enabled: () => undoGoesToPages() || (notesUndo?.enabled() ?? false),
    },
    'edit.redo': {
      run: () => {
        const to = redoGoesTo();
        if (to === 'pages') {
          tookRedo('pages');
          pages.redo();
        } else if (to === 'notes') {
          tookRedo('notes');
          notesRedo?.run();
        }
      },
      enabled: () => {
        const to = redoGoesTo();
        return to === 'pages' || (to === 'notes' && (notesRedo?.enabled() ?? false));
      },
    },
    ...(markMenu ? { 'marks.menu': { ...markMenu, enabled: () => !inThumbnails() && markMenu.enabled() } } : {}),
  };
}
