// "Comment" in the toolbar pill, as Drive's signed-in viewer has it (02 section 4.10: a text button with add_comment,
// in its own group at the end of the pill). It runs Ctrl+Alt+M: a note on the selection, or on the page in view.
// "Notes" follows it: the notes panel, with how many notes the PDF has (notes-panel/NotesButton.tsx).
import { TextButton, Tooltip } from '@sop/ui';
import { useSyncExternalStore } from 'react';
import styles from './CommentButton.module.css';
import { isIncognito } from '../incognito';
import { NotesButton } from '../notes-panel';
import { NOTE_COMMANDS } from './note-commands';
import { noteCommands, subscribeNoteCommands } from './notes-host';

export function CommentButton() {
  const cmds = useSyncExternalStore(subscribeNoteCommands, noteCommands);
  const cmd = cmds?.['marks.comment'];
  const spec = NOTE_COMMANDS['marks.comment'];
  if (isIncognito()) return null; // Incognito only views PDFs: no marks, no notes
  // Off only for a moment, while the PDF's notes load: the tooltip says so rather than leave it greyed with no reason.
  const off = cmd === undefined || !cmd.enabled();
  return (
    <>
      <Tooltip label={off ? 'Add a comment: wait for the PDF to open' : 'Add a comment'} {...(off ? {} : { shortcut: spec.keys[0] })}>
        <TextButton
          label={spec.label}
          icon={spec.icon}
          className={styles.button}
          disabled={off}
          // Keep the text selection: pressing the button must not clear what the note is about.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => cmd?.run()}
        />
      </Tooltip>
      <NotesButton />
    </>
  );
}
