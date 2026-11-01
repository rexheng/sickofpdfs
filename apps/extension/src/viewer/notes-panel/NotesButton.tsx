// "Notes" in the toolbar pill, beside "Comment": every note of the PDF in the panel (Shift+F4), with how many there are.
// It replaces the round "Show notes" button that sat at the bottom right over the margin, where it hid a card's Send
// button and its words (TB2 critics). When the cards do not fit beside the pages (R69), they fold into this button.
import { TextButton, Tooltip } from '@sop/ui';
import { useNotesButton, useNotesPanelOpen } from './panel-state';
import styles from './NotesButton.module.css';

export function NotesButton() {
  const b = useNotesButton();
  const open = useNotesPanelOpen();
  if (b === null) return null;
  const count = b.count === 1 ? '1 note' : `${b.count} notes`;
  return (
    <Tooltip label={open ? 'Hide notes' : 'Show all notes'} shortcut="Shift+F4">
      <TextButton
        label={b.count > 0 ? `Notes ${b.count}` : 'Notes'}
        icon="comment"
        className={styles.button}
        aria-label={`Notes, ${count}`}
        aria-pressed={open}
        // Keep the text selection: opening the panel must not clear what the reader selected.
        onMouseDown={(e) => e.preventDefault()}
        onClick={b.toggle}
      />
    </Tooltip>
  );
}
