// The notes panel (S15) as a viewer feature: App.tsx mounts it with one line, registerViewerFeature(notesPanelFeature).
// Its three commands (Shift+F4, Ctrl+Alt+N, Ctrl+Alt+P) go into the viewer's command list through `onCommands`, so the
// keys, the shortcut sheet and the menus all come from one place and the mount installs no keys of its own.
import type { NotesHost, ViewerFeature } from '../annotations/wire';
import type { CommandBehaviour } from '../commands';
import type { NotesCommand, NotesCommandId } from './commands';
import { NotesPanelMount } from './NotesPanelMount';

let published: NotesCommand[] | null = null;

/** Stable, so the mount publishes once. */
const onCommands = (c: NotesCommand[] | null) => {
  published = c;
};

function delegate(id: NotesCommandId, checked = false): CommandBehaviour {
  const find = () => published?.find((c) => c.id === id);
  return {
    run: () => find()?.run(),
    enabled: () => find()?.enabled() ?? false,
    ...(checked ? { checked: () => find()?.checked?.() ?? false } : {}),
  };
}

function NotesPanelView({ host }: { host: NotesHost }) {
  // Task 24's jump history is not merged yet: without it a note jump shows the note's page (S15's null path).
  return <NotesPanelMount session={host.session} pageList={host.pageList} viewer={host.view} pages={host.pages} jumps={null} onCommands={onCommands} />;
}

export const notesPanelFeature: ViewerFeature = {
  id: 'notes-panel',
  commands: () => ({ 'notes.panel': delegate('notes.panel', true), 'notes.next': delegate('notes.next'), 'notes.previous': delegate('notes.previous') }),
  View: NotesPanelView,
};
