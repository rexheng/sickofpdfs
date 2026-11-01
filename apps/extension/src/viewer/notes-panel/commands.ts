// The notes panel's commands (plan section 7: ViewerCommandId gains 'notes.next', 'notes.previous' and 'notes.panel').
// Each has the shape of a ViewerCommand, so the viewer's command list can take them as they are: the View menu, the
// shortcut sheet and the keys then all come from one place. Until the viewer's list takes them, NotesPanelMount
// installs their keys itself.
import type { IconName } from '@sop/ui';
import type { KeyCombo } from '../shortcuts';

export type NotesCommandId = 'notes.panel' | 'notes.next' | 'notes.previous';

export interface NotesCommand {
  id: NotesCommandId;
  label: string;
  icon: IconName;
  keys: KeyCombo[];
  run(): void;
  enabled(): boolean;
  checked?(): boolean;
}

/** Labels, icons and keys (spec "Shortcuts": Next / previous note Ctrl+Alt+N / Ctrl+Alt+P; Notes panel Shift+F4). */
export const NOTES_COMMAND_SPECS: Record<NotesCommandId, { label: string; icon: IconName; keys: KeyCombo[] }> = {
  'notes.panel': { label: 'Notes panel', icon: 'comment', keys: ['Shift+F4'] },
  'notes.next': { label: 'Next note', icon: 'keyboard_arrow_down', keys: ['Ctrl+Alt+N'] },
  'notes.previous': { label: 'Previous note', icon: 'keyboard_arrow_up', keys: ['Ctrl+Alt+P'] },
};

export interface NotesActions {
  togglePanel(): void;
  panelOpen(): boolean;
  step(dir: 1 | -1): void;
  /** Notes are on in this tab (not Incognito). */
  available(): boolean;
}

/** The three commands, run by `a`. */
export function createNotesCommands(a: NotesActions): NotesCommand[] {
  const spec = (id: NotesCommandId) => ({ id, ...NOTES_COMMAND_SPECS[id] });
  return [
    { ...spec('notes.panel'), run: () => a.togglePanel(), enabled: () => a.available(), checked: () => a.panelOpen() },
    { ...spec('notes.next'), run: () => a.step(1), enabled: () => a.available() },
    { ...spec('notes.previous'), run: () => a.step(-1), enabled: () => a.available() },
  ];
}
