// The comment commands: Ctrl+Alt+M comments on the selection (or makes a note at the pointer, or for the page), and
// Ctrl+Alt+Shift+M makes a note on the whole document (spec "Shortcuts").
//
// The keys are bound once, by the viewer's command list (commands.ts and shortcuts.ts, which also finds Ctrl+Alt+M on
// AltGr layouts such as German, where it types "µ"). This file names the commands and the shape of what they do.

/** The command ids (plan section 7) and their keys, as the shortcut sheet shows them. */
export const NOTE_COMMANDS = {
  'marks.comment': { label: 'Comment', icon: 'add_comment', keys: ['Ctrl+Alt+M'] },
  'marks.documentNote': { label: 'Note on the whole document', icon: 'comment', keys: ['Ctrl+Alt+Shift+M'] },
} as const;

export type NoteCommandId = keyof typeof NOTE_COMMANDS;

/** What a command does in this tab, in the shape of commands.ts's ViewerCommand behaviour. */
export interface NoteCommandBehaviour {
  run(): void;
  enabled(): boolean;
}
