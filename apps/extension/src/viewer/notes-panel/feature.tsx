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
  // Note jumps go through the reader's jump history (Task 24), so a run of them is one Back step.
  return <NotesPanelMount session={host.session} pageList={host.pageList} viewer={host.view} pages={host.pages} jumps={host.jumps} onCommands={onCommands} />;
}

export const notesPanelFeature: ViewerFeature = {
  id: 'notes-panel',
  commands: () => ({ 'notes.panel': delegate('notes.panel', true), 'notes.next': delegate('notes.next'), 'notes.previous': delegate('notes.previous') }),
  View: NotesPanelView,
};
