// The notes panel and note navigation (Phase 2, slice S15). App.tsx mounts NotesPanelMount with one line.
export { createNotesCommands, NOTES_COMMAND_SPECS, type NotesCommand, type NotesCommandId } from './commands';
export { NotesPanelMount, type NotesPanelMountProps } from './NotesPanelMount';
export { CARDS_FOLD_BELOW_PX, cardsFolded, notesPanel, useCardsFolded, useNotesPanelOpen } from './panel-state';
